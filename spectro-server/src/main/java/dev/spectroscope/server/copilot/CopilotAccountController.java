package dev.spectroscope.server.copilot;

import dev.spectroscope.core.copilot.CopilotAccount;
import dev.spectroscope.server.web.LocalOrigin;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The Copilot sign-in sheet's endpoints (card 495).
 *
 * <p>{@code GET /api/copilot/account} says where the sign-in stands: the state,
 * the method ({@code github} or {@code cli}), the login when signed in, and
 * while a device flow waits, the user code and the address to open. It never
 * carries a token or the device code. {@code POST .../sign-in},
 * {@code .../cancel} and {@code .../sign-out} change it.</p>
 *
 * <p>The writes wear the key writer's two fences ({@code /api/onboarding/key}):
 * a local {@code Host} against DNS rebinding, and an {@code Origin} that is
 * loopback or absent against a real website posting here. Both answer 404.
 * {@code consumes=json} makes a cross-site form post a 415 and a cross-site
 * script post a CORS preflight nobody answers. The read wears the Host fence,
 * like every other {@code /api} read.</p>
 */
@RestController
public class CopilotAccountController {

    private final CopilotAccount account;

    /** The account of this machine. */
    public CopilotAccountController() {
        this(CopilotAccount.forThisMachine());
    }

    CopilotAccountController(CopilotAccount account) {
        this.account = account;
    }

    /**
     * The sign-in body.
     *
     * @param method {@code github} or {@code cli}
     */
    public record SignInBody(String method) {}

    /**
     * {@code GET /api/copilot/account}.
     *
     * @param request the servlet request, for the Host fence
     * @return the status, or 404 for a caller that is not local
     */
    @GetMapping("/api/copilot/account")
    public ResponseEntity<Map<String, Object>> status(HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(body(account.status()));
    }

    /**
     * {@code POST /api/copilot/account/sign-in}: starts a device flow, or takes
     * the Copilot CLI's stored sign-in when the method is {@code cli} and the
     * CLI has one.
     *
     * @param body    the method
     * @param request the servlet request, for the fences
     * @return the status, 400 for an unknown method, 404 for a refused caller
     */
    @PostMapping(value = "/api/copilot/account/sign-in", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> signIn(@RequestBody(required = false) SignInBody body,
                                                      HttpServletRequest request) {
        if (!writable(request)) {
            return ResponseEntity.notFound().build();
        }
        String method = body == null ? null : body.method();
        if ("github".equals(method)) {
            return ResponseEntity.ok(body(account.signInWithGitHub()));
        }
        if ("cli".equals(method)) {
            return ResponseEntity.ok(body(account.signInWithCli()));
        }
        return ResponseEntity.badRequest().body(Map.of("error", "method is github or cli"));
    }

    /**
     * {@code POST /api/copilot/account/cancel}: stops a waiting sign-in.
     *
     * @param request the servlet request, for the fences
     * @return the status, or 404 for a refused caller
     */
    @PostMapping(value = "/api/copilot/account/cancel", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> cancel(HttpServletRequest request) {
        if (!writable(request)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(body(account.cancel()));
    }

    /**
     * {@code POST /api/copilot/account/sign-out}: deletes the stored tokens, or
     * the choice of the CLI's sign-in. The Copilot CLI's own sign-in is left alone.
     *
     * @param request the servlet request, for the fences
     * @return the status, or 404 for a refused caller
     */
    @PostMapping(value = "/api/copilot/account/sign-out", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> signOut(HttpServletRequest request) {
        if (!writable(request)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(body(account.signOut()));
    }

    private static boolean writable(HttpServletRequest request) {
        return LocalOrigin.isLocalOrigin(request) && LocalOrigin.originIsLoopbackOrAbsent(request);
    }

    private Map<String, Object> body(CopilotAccount.Status status) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("state", status.state().name());
        out.put("method", status.method());
        out.put("login", status.login());
        out.put("userCode", status.userCode());
        out.put("verificationUri", status.verificationUri());
        out.put("expiresAt", status.expiresAt());
        out.put("message", status.message());
        out.put("github", account.gitHubAvailable());
        out.put("cli", account.cliAvailable());
        return out;
    }
}
