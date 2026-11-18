import { APP_URL, REPO_URL, SCORECARD_URL } from "../config";
import { BrandMark } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";

import styles from "./chrome.module.css";

const SECTIONS = [
  { href: "#how", label: "How it works" },
  { href: "#why", label: "Why it holds" },
  { href: "#agents", label: "For agents" },
] as const;

export function SkipLink() {
  return (
    <a className={styles.skip} href="#main">
      Skip to content
    </a>
  );
}

export function Nav() {
  return (
    <header id="top" className={styles.header}>
      <nav className={styles.nav} aria-label="Main">
        <a className={styles.brand} href="#top" aria-label="Mandate, top of the page">
          <BrandMark className={styles.brandMark} />
          <span className={styles.brandName}>Mandate</span>
        </a>
        <ul className={styles.links}>
          {SECTIONS.map((section) => (
            <li key={section.href}>
              <a href={section.href}>{section.label}</a>
            </li>
          ))}
        </ul>
        <a className={styles.launch} href={APP_URL}>
          Launch app
        </a>
      </nav>
    </header>
  );
}

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerRow}>
        <div className={styles.footerBrand}>
          <a className={styles.brand} href="#top" aria-label="Mandate, top of the page">
            <BrandMark className={styles.brandMark} />
            <span className={styles.brandName}>Mandate</span>
          </a>
          <p className={styles.footerNote}>
            Built for the UBC 2026 Hackathon. Test networks only: orders go to Gemini's sandbox with test
            funds, and no real money moves.
          </p>
        </div>
        <ul className={styles.footerLinks}>
          <li>
            <a href={APP_URL}>Launch app</a>
          </li>
          <li>
            <a href={SCORECARD_URL}>Public scorecard</a>
          </li>
          {REPO_URL === "" ? null : (
            <li>
              <a href={REPO_URL}>Source on GitHub</a>
            </li>
          )}
          <li>
            <ThemeToggle />
          </li>
        </ul>
      </div>
      <svg className={styles.wordmark} viewBox="0 0 1000 170" aria-hidden="true">
        <text x="0" y="200" textLength="1000" lengthAdjust="spacingAndGlyphs">
          Mandate
        </text>
      </svg>
    </footer>
  );
}
