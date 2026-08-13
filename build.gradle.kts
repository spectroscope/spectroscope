// The root build carries no plugins and no dependencies: the five Java modules
// each configure their own toolchain, compile options and publishing. What lives
// here is the one setting that has to hold identically in all of them, because a
// number that means different things per module means nothing at all.

subprojects {
    tasks.withType<Javadoc>().configureEach {
        // javadoc stops PRINTING after -Xmaxwarns warnings — default 100 — and
        // then reports how many it printed, not how many it found. Measured on
        // 2026-08-13 with `./gradlew javadoc --rerun-tasks --no-build-cache`:
        // spectro-core and spectro-server each ended on exactly "100 warnings",
        // so the 254 that reviews quoted was two real counts, two ceilings, and
        // a sum that could not move. Removing one warning in spectro-core left
        // the total at 254 — it only uncovered the next suppressed one.
        //
        // A count that cannot go down is worse than no count, and two review
        // reports had already quoted this one as a measurement. The ceiling is
        // lifted far past any plausible real count, so the printed number is the
        // found number and `did my change add warnings?` has an answer again.
        (options as StandardJavadocDocletOptions).addStringOption("Xmaxwarns", "10000")
    }
}
