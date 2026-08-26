// Which card view the Lab opens in (card 287, owner-decided): replay and
// import open as the PLAYER — expanded, the full worker cards — while live
// stays the calm compact observation picture. An explicit choice, once made,
// wins everywhere and keeps winning (it is the stored value).
export function labViewDefault(stored: string | null, hasReplay: boolean): boolean {
  if (stored === "expanded") return true;
  if (stored === "compact") return false;
  return hasReplay;
}
