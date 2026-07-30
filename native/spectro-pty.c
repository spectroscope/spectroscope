/*
 * spectro-pty — the pseudo-terminal helper for spectroscope's Files-tab shell
 * (card 93). About 280 lines of C under the comments, so the server can hand a
 * browser a real terminal instead of a command box.
 *
 * WHY A HELPER AT ALL. A correct PTY needs code running in the child between
 * fork() and exec(): setsid() plus TIOCSCTTY, i.e. a controlling terminal.
 * Without that step isatty() is still true — zsh prints a prompt, oh-my-zsh
 * renders its theme — but there IS no controlling terminal, so Ctrl-C generates
 * no SIGINT and job control complains. The JDK cannot run code there, so
 * something native has to; openpty() plus a hand-written child does it in a
 * dozen lines, which is why the whole helper is small.
 *
 * WHY NOT A LIBRARY. pty4j is the higher-fidelity answer and would be the pick
 * if the app were not notarized: it dlopens a libpty extracted from its jar at
 * runtime, and under Hardened Runtime library validation rejects a dylib not
 * signed by our team. Pre-signing it means doing this bundling anyway, on top of
 * a dependency and an EPL-1.0 native in an MIT repo. Calling forkpty through
 * JNA/FFM instead puts a fork() inside a live multithreaded JVM, where the child
 * may only call async-signal-safe functions and can deadlock on a malloc lock
 * before execvp — it works most of the time, the worst property a shell can
 * have. `script -q /dev/null $SHELL` needs no code at all but sizes the pty from
 * its own stdin tty, and ours is a pipe: the window is stuck forever and vim
 * paints garbage.
 *
 * THE ANTI-ORPHAN PROPERTY, which is the other reason this is ours: the loop
 * exits when its own stdin reaches EOF, and takes the shell's process group with
 * it. A `kill -9` of the server runs no shutdown hook and calls no destroy(),
 * but it does close the pipe — so the shell still dies. No library offers that.
 *
 *   usage:  spectro-pty <rows> <cols> -- <shell> [args...]
 *
 * stdin   framed:  [type u8][len u32 big-endian][payload]
 *                  type 0x00  payload -> the terminal's input
 *                  type 0x01  payload = rows u16, cols u16 (big-endian) -> TIOCSWINSZ
 *                  anything else is a confused caller: exit, do not guess
 * stdout  raw terminal output, unframed
 * stderr  diagnostics only; the terminal stream is NEVER written here (a shell
 *         is where passwords get typed, and stderr is what ends up in logs)
 *
 * exit    the shell's exit status, or 128+signal when it was signalled;
 *         2 for a usage or protocol error, 1 when the pty could not be created
 */

/* glibc hides the POSIX surface this file uses — kill, sigaction, usleep —
 * behind feature-test macros when compiled as strict -std=c11; Darwin exposes
 * it regardless, which is why the gap only shows on a Linux runner. The
 * defines must precede every include. _XOPEN_SOURCE 700 uncovers kill and
 * sigaction; _DEFAULT_SOURCE keeps usleep, which POSIX.1-2008 dropped. */
#define _XOPEN_SOURCE 700
#define _DEFAULT_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <util.h>
#else
#include <pty.h>
#endif

#define IN_BUF_CAP   (1024 * 1024)  /* accumulated stdin frames */
#define PTY_BUF_CAP  (256 * 1024)   /* keystrokes waiting for the terminal */
#define MAX_FRAME    (256 * 1024)   /* a paste; anything larger is not a paste */
#define OUT_CHUNK    (16 * 1024)

static volatile sig_atomic_t stop_flag = 0;
static pid_t child_pid = -1;

static void on_signal(int signo) {
    (void) signo;
    stop_flag = 1;
}

/* Whether a waitpid() result means the child is really finished. A stop is not
 * an exit, and ECHILD means somebody already reaped it. */
static int gone(pid_t waited, int status) {
    if (waited == -1 && errno == ECHILD) {
        return 1;
    }
    return waited > 0 && !WIFSTOPPED(status);
}

/* Signal the shell's process group AND the shell itself. The group carries the
 * shell's own jobs with it; the bare pid is the belt: a child whose session did
 * not come out as expected is still reachable that way. */
static void signal_child(int sig) {
    if (child_pid > 0) {
        kill(-child_pid, sig);
        kill(child_pid, sig);
    }
}

/*
 * Take the shell down, escalating SIGHUP (what a closing terminal sends, and
 * what zsh forwards to its jobs) then SIGTERM then SIGKILL. Returns the shell's
 * wait status.
 *
 * Two details are load-bearing, both found by a helper that hung instead of
 * exiting. WUNTRACED, because a child stopped by SIGTTOU is never reported to a
 * plain waitpid() — and a plain blocking waitpid() then waits on it forever,
 * which is what the hang was. And SIGCONT before each rung, because a stopped
 * process cannot act on SIGHUP or SIGTERM at all. Every wait is bounded: a child
 * that refuses to die must not take the helper's exit with it, because the helper
 * exiting is what closes the socket.
 */
static int reap_child(void) {
    static const int ladder[3] = {SIGHUP, SIGTERM, SIGKILL};
    int status = 0;
    int rung, i;
    if (child_pid <= 0) {
        return 0;
    }
    if (gone(waitpid(child_pid, &status, WNOHANG | WUNTRACED), status)) {
        child_pid = -1;
        return status;
    }
    for (rung = 0; rung < 3; rung++) {
        signal_child(SIGCONT);
        signal_child(ladder[rung]);
        for (i = 0; i < 20; i++) { /* 1s per rung */
            if (gone(waitpid(child_pid, &status, WNOHANG | WUNTRACED), status)) {
                child_pid = -1;
                return status;
            }
            usleep(50 * 1000);
        }
    }
    child_pid = -1; /* unkillable: report nothing rather than never return */
    return 0;
}

/* Write everything or die trying; a short write on a pipe is normal. */
static int write_all(int fd, const unsigned char *buf, size_t len) {
    size_t done = 0;
    while (done < len) {
        ssize_t n = write(fd, buf + done, len - done);
        if (n > 0) {
            done += (size_t) n;
            continue;
        }
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) {
            continue;
        }
        return -1;
    }
    return 0;
}

static void set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) {
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    }
}

static int clamp(int value, int low, int high) {
    if (value < low) {
        return low;
    }
    if (value > high) {
        return high;
    }
    return value;
}

int main(int argc, char **argv) {
    int rows, cols, master = -1, slave = -1;
    struct winsize ws;
    pid_t pid;
    unsigned char *in_buf, *pty_buf;
    size_t in_len = 0, pty_len = 0;
    int stdin_open = 1, child_exited = 0, status = 0;
    struct sigaction sa;

    if (argc < 5 || strcmp(argv[3], "--") != 0) {
        fprintf(stderr, "usage: spectro-pty <rows> <cols> -- <shell> [args...]\n");
        return 2;
    }
    rows = clamp(atoi(argv[1]), 1, 1000);
    cols = clamp(atoi(argv[2]), 1, 1000);

    signal(SIGPIPE, SIG_IGN);
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_signal;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);

    memset(&ws, 0, sizeof(ws));
    ws.ws_row = (unsigned short) rows;
    ws.ws_col = (unsigned short) cols;

    if (openpty(&master, &slave, NULL, NULL, &ws) == -1) {
        perror("spectro-pty: openpty");
        return 1;
    }
    pid = fork();
    if (pid < 0) {
        perror("spectro-pty: fork");
        return 1;
    }
    if (pid == 0) {
        /*
         * The child, and the reason this helper exists: the three calls below are
         * what give the shell a CONTROLLING terminal, and they can only run here,
         * between fork and exec. Without them isatty() is still true — zsh prints
         * a prompt, oh-my-zsh renders its theme — but Ctrl-C produces no SIGINT
         * and job control breaks.
         *
         * Done by hand rather than through forkpty(), which calls login_tty() and
         * DISCARDS its return value: when TIOCSCTTY fails there, the child lands
         * on a pty with no controlling terminal and nothing says so. A shell that
         * silently ignores Ctrl-C is worse than one that refuses to start, so a
         * failure here is fatal. perror still reaches the real stderr — the dup2s
         * that would redirect it into the terminal have not happened yet.
         */
        close(master);
        if (setsid() == -1) {
            perror("spectro-pty: setsid");
            _exit(126);
        }
        if (ioctl(slave, TIOCSCTTY, (char *) NULL) == -1) {
            perror("spectro-pty: TIOCSCTTY");
            _exit(126);
        }
        if (dup2(slave, STDIN_FILENO) == -1 || dup2(slave, STDOUT_FILENO) == -1
                || dup2(slave, STDERR_FILENO) == -1) {
            _exit(126);
        }
        if (slave > STDERR_FILENO) {
            close(slave);
        }
        signal(SIGPIPE, SIG_DFL);
        signal(SIGHUP, SIG_DFL);
        signal(SIGINT, SIG_DFL);
        signal(SIGTERM, SIG_DFL);
        execvp(argv[4], &argv[4]);
        perror("spectro-pty: exec");
        _exit(127);
    }
    close(slave); /* the child owns it now; ours would keep the master readable */
    child_pid = pid;

    in_buf = malloc(IN_BUF_CAP);
    pty_buf = malloc(PTY_BUF_CAP);
    if (!in_buf || !pty_buf) {
        fprintf(stderr, "spectro-pty: out of memory\n");
        reap_child();
        return 1;
    }

    /* The master must never block on write: the shell can be blocked writing
     * output while we are blocked writing input, and that is a deadlock with no
     * way out. Pending keystrokes wait in a bounded buffer instead, and when it
     * is full we simply stop reading stdin — backpressure, not loss. */
    set_nonblocking(master);

    while (1) {
        struct pollfd fds[2];
        int nfds = 0, stdin_slot = -1, master_slot;

        if (stdin_open && in_len < IN_BUF_CAP && pty_len < PTY_BUF_CAP) {
            fds[nfds].fd = STDIN_FILENO;
            fds[nfds].events = POLLIN;
            stdin_slot = nfds++;
        }
        fds[nfds].fd = master;
        fds[nfds].events = POLLIN | (pty_len > 0 ? POLLOUT : 0);
        master_slot = nfds++;

        if (poll(fds, (nfds_t) nfds, 200) < 0 && errno != EINTR) {
            break;
        }
        if (stop_flag) {
            break;
        }

        /* 1. stdin -> frames */
        if (stdin_slot >= 0 && (fds[stdin_slot].revents & (POLLIN | POLLHUP))) {
            ssize_t n = read(STDIN_FILENO, in_buf + in_len, IN_BUF_CAP - in_len);
            if (n > 0) {
                in_len += (size_t) n;
            } else if (n == 0) {
                stdin_open = 0; /* the JVM is gone — this is the anti-orphan path */
            } else if (errno != EINTR && errno != EAGAIN) {
                stdin_open = 0;
            }
        }

        /* 2. decode whole frames */
        while (in_len >= 5) {
            unsigned char type = in_buf[0];
            size_t len = ((size_t) in_buf[1] << 24) | ((size_t) in_buf[2] << 16)
                    | ((size_t) in_buf[3] << 8) | (size_t) in_buf[4];
            if (len > MAX_FRAME) {
                fprintf(stderr, "spectro-pty: frame of %zu bytes refused\n", len);
                reap_child();
                return 2;
            }
            if (in_len < 5 + len) {
                break; /* the rest is still in flight */
            }
            if (type == 0x00) {
                if (pty_len + len > PTY_BUF_CAP) {
                    break; /* no room yet; drain to the terminal first */
                }
                memcpy(pty_buf + pty_len, in_buf + 5, len);
                pty_len += len;
            } else if (type == 0x01) {
                if (len != 4) {
                    fprintf(stderr, "spectro-pty: bad resize frame\n");
                    reap_child();
                    return 2;
                }
                memset(&ws, 0, sizeof(ws));
                ws.ws_row = (unsigned short) clamp(
                        (in_buf[5] << 8) | in_buf[6], 1, 1000);
                ws.ws_col = (unsigned short) clamp(
                        (in_buf[7] << 8) | in_buf[8], 1, 1000);
                /* The kernel raises SIGWINCH on the foreground group for us. */
                ioctl(master, TIOCSWINSZ, &ws);
            } else {
                fprintf(stderr, "spectro-pty: unknown frame type %u\n", type);
                reap_child();
                return 2;
            }
            memmove(in_buf, in_buf + 5 + len, in_len - (5 + len));
            in_len -= 5 + len;
        }

        /* 3. pending keystrokes -> the terminal */
        if (pty_len > 0 && (fds[master_slot].revents & POLLOUT)) {
            ssize_t n = write(master, pty_buf, pty_len);
            if (n > 0) {
                memmove(pty_buf, pty_buf + n, pty_len - (size_t) n);
                pty_len -= (size_t) n;
            } else if (n < 0 && errno != EINTR && errno != EAGAIN) {
                break;
            }
        }

        /* 3b. stdin is gone and everything typed has landed: this is the whole
         *     anti-orphan property. Leaving the loop reaps the process group, so
         *     a hard-killed JVM — no shutdown hook, no destroy() — still takes
         *     its shell with it. */
        if (!stdin_open && pty_len == 0) {
            break;
        }

        /* 4. the terminal -> stdout. Blocking on purpose: a JVM that stops
         *    reading backs this up into the terminal's own buffer and the shell
         *    blocks on write, which is what a slow terminal has always done. */
        if (fds[master_slot].revents & (POLLIN | POLLHUP)) {
            unsigned char out[OUT_CHUNK];
            ssize_t n = read(master, out, sizeof(out));
            if (n > 0) {
                if (write_all(STDOUT_FILENO, out, (size_t) n) < 0) {
                    break; /* nobody is listening any more */
                }
            } else if (n == 0 || (n < 0 && errno == EIO)) {
                break; /* the slave closed: the shell exited */
            } else if (n < 0 && errno != EINTR && errno != EAGAIN) {
                break;
            }
        }

        /* 5. the shell exited. macOS does NOT reliably report the master
         *    readable once the last slave is closed, so poll alone would sit
         *    here forever after `exit` — the child's own status is the signal
         *    that works. Measured, not assumed: without this the helper hung. */
        if (child_pid > 0 && waitpid(child_pid, &status, WNOHANG) == child_pid) {
            child_pid = -1;
            child_exited = 1;
            break;
        }
    }

    /* One last drain so the shell's goodbye is not lost, then reap. */
    {
        unsigned char out[OUT_CHUNK];
        ssize_t n;
        int guard = 64;
        set_nonblocking(master);
        while (guard-- > 0 && (n = read(master, out, sizeof(out))) > 0) {
            if (write_all(STDOUT_FILENO, out, (size_t) n) < 0) {
                break;
            }
        }
    }
    if (!child_exited) {
        status = reap_child();
    }
    close(master);
    free(in_buf);
    free(pty_buf);
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        return 128 + WTERMSIG(status);
    }
    return 0;
}
