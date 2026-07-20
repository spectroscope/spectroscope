// Ambient particle backdrop: the brand dust signature. A fixed z-index:-1
// canvas portaled to <body> (above the body gradient, behind the UI). Colors
// are read live from the active design's CSS vars, so it always matches.
// Static under reduced motion, paused when the tab is hidden. spectro white
// deliberately renders nothing.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { DesignId } from "../state/designPrefs";

type Style = "dust";

function styleFor(design: DesignId): Style | null {
  switch (design) {
    case "spectroscope":
      // Brand dark: fine warm grain rising off the espresso ground (scenes may
      // glow, marks never do — dust stays crisp and calm).
      return "dust";
    case "paper":
      // Brand light: the landing page's ink dots on paper.
      return "dust";
    default:
      // spectro white (`still`): deliberately no particle signature.
      return null;
  }
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  alpha: number;
  /** Colored vertical bar (a spectral ray) instead of a neutral pixel. */
  spectral: boolean;
  /** Twinkle phase — neutral pixels breathe, rays hold steady. */
  tw: number;
}

export function ParticleField({ design, enabled }: { design: DesignId; enabled: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const style = styleFor(design);
  const active = enabled && style !== null;

  useEffect(() => {
    if (!active || style === null) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const cs = getComputedStyle(document.documentElement);
    const neutral = (cs.getPropertyValue("--text-faint") || "#8d8a84").trim() || "#8d8a84";
    // The rays wear ALL brand line colors (owner 2026-07-20) — the same
    // spectral palette the landing page reads: red, amber, teal, ocean, violet.
    const line = (name: string, fallback: string): string =>
      (cs.getPropertyValue(name) || fallback).trim() || fallback;
    const rays = [
      line("--sp-red", "#C05A4C"),
      line("--sp-amber", "#CE9440"),
      line("--sp-teal", "#2DD4A7"),
      line("--sp-ocean", "#2CB1C4"),
      line("--sp-violet", "#8B7CF0"),
    ];
    // The brand drift runs at half tempo (owner 2026-07-20).
    const speed = 0.5;

    let w = 0;
    let h = 0;

    // The landing page's matter pixels (owner 2026-07-20): blocky squares that
    // twinkle, and colored VERTICAL BARS — light rays, each one a spectral
    // line. Both rise slowly; positions snap to whole pixels so the marks stay
    // crisp instead of blurring on subpixels.
    const spawn = (): Particle => {
      const spectral = Math.random() < 0.35;
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.2 * speed,
        vy: -(0.15 + Math.random() * 0.35) * speed,
        r: spectral ? 1.5 + Math.random() * 1.2 : 1 + Math.random() * 1.2,
        color: spectral ? rays[Math.floor(Math.random() * rays.length)] : neutral,
        alpha: spectral ? 0.5 : 0.18 + Math.random() * 0.16,
        spectral,
        tw: Math.random() * Math.PI * 2,
      };
    };

    // Seed lazily on the first non-zero size, so a mount at 0×0 (headless, hidden
    // tab) still fills once the real viewport arrives.
    let particles: Particle[] = [];
    const ensureSeed = (): void => {
      if (w <= 0 || particles.length > 0) return;
      const count = Math.min(150, Math.round(w / 10));
      particles = Array.from({ length: Math.max(8, count) }, spawn);
    };

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ensureSeed();
    };
    resize();

    const wrap = (p: Particle): void => {
      if (p.x < -60) p.x = w + 60;
      if (p.x > w + 60) p.x = -60;
      if (p.y < -60) p.y = h + 60;
      if (p.y > h + 60) p.y = -60;
    };

    const draw = (): void => {
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        const breathe = p.spectral ? p.alpha : Math.max(0.05, p.alpha + Math.sin(p.tw) * 0.1);
        ctx.globalAlpha = breathe;
        ctx.fillStyle = p.color;
        // Blocky marks: a square pixel, or a 3.2× tall bar for a spectral ray.
        ctx.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.r), Math.round(p.spectral ? p.r * 3.2 : p.r));
      }
      ctx.globalAlpha = 1;
    };

    let raf = 0;
    const loop = (): void => {
      if (!document.hidden) {
        for (const p of particles) {
          p.x += p.vx;
          p.y += p.vy;
          p.tw += 0.016;
          wrap(p);
        }
        draw();
      }
      raf = requestAnimationFrame(loop);
    };

    if (reduced) {
      draw();
    } else {
      raf = requestAnimationFrame(loop);
    }
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [active, style, design]);

  if (!active) return null;
  return createPortal(<canvas ref={canvasRef} className="particle-field" aria-hidden="true" />, document.body);
}
