/**
 * tests/fixtures/happyDomSelects.ts — work around happy-dom's `<option selected>`
 * parsing bug in the *Dom.test.ts suites.
 *
 * happy-dom does not apply `selected` correctly when parsing markup: a select
 * whose selected option is not the first reports a NEIGHBOURING option instead
 * (verified 2026-08-17 on a 3-option select — `selected` on option 3 gave
 * `value === "b"`). Every DOM test that reads a rendered select is therefore
 * testing the environment rather than the code unless it repairs the value
 * first. Real browsers honour `selected`, so product code is unaffected — which
 * is also why some render paths assign select values from JS instead of
 * trusting their own markup.
 *
 * fixSelects(root) walks every <select> under `root` and sets `.value` from the
 * option that actually carries the `selected` attribute, leaving selects with no
 * marked option alone (their first-option default is correct in both engines).
 */
export function fixSelects(root: { querySelectorAll: (s: string) => Iterable<unknown> }): void {
  for (const el of Array.from(root.querySelectorAll("select"))) {
    const sel = el as unknown as {
      value: string;
      querySelector: (s: string) => { getAttribute: (a: string) => string | null } | null;
    };
    const marked = sel.querySelector("option[selected]");
    if (marked) sel.value = marked.getAttribute("value") ?? "";
  }
}
