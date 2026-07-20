// Scroll-reveal: when fx-scroll is on, elements marked [data-reveal] start
// hidden (see designs.css) and get `.in` as they enter the viewport. The CSS
// only hides them under fx-scroll AND prefers-reduced-motion:no-preference, so
// with the effect off — or reduced motion — content is always fully visible and
// this hook is a no-op. A MutationObserver picks up panels mounted later (tab
// switches), so nothing tagged can stay stuck hidden.

import { useEffect } from "react";

const REVEAL_SELECTOR = "[data-reveal]";
// Reveal when ~4% of the element is visible, 8% before the viewport bottom.
const REVEAL_ROOT_MARGIN = "0px 0px -8% 0px";
const REVEAL_VISIBILITY_THRESHOLD = 0.04;

export function useScrollReveal(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return;
    // Under reduced motion the CSS never hides [data-reveal], so nothing to do.
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: REVEAL_ROOT_MARGIN, threshold: REVEAL_VISIBILITY_THRESHOLD },
    );

    const observe = (el: Element): void => {
      if (!el.classList.contains("in")) io.observe(el);
    };
    const scan = (root: ParentNode): void => {
      root.querySelectorAll(REVEAL_SELECTOR).forEach(observe);
    };

    scan(document);

    // Panels mounted after setup (e.g. switching tabs) must reveal too.
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches(REVEAL_SELECTOR)) observe(node);
          scan(node);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [enabled]);
}
