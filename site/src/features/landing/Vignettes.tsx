import styles from "./vignettes.module.css";

/* Small looping pictures beside the three steps. They repeat what the step's text says, so they are
   hidden from assistive technology and hold still under reduced motion. */

export function MandateVignette() {
  return (
    <div className={`${styles.stage} ${styles.mandate}`} aria-hidden="true">
      <div className={styles.card}>
        <div className={styles.line}>
          <span>Budget</span>
          <span className="num">$200.00</span>
        </div>
        <div className={styles.line}>
          <span>Max trade</span>
          <span className="num">$25.00</span>
        </div>
        <div className={styles.line}>
          <span>You sign above</span>
          <span className="num">$20.00</span>
        </div>
        <div className={styles.signature}>
          <svg viewBox="0 0 120 20" fill="none">
            <path d="M2 14c8-10 14-10 14-2s6 4 12-4 8-4 10 2 6 4 14-6 10 0 12 6 8 2 16-4 12-2 34 4" />
          </svg>
          <span>Signed by your wallet</span>
        </div>
      </div>
    </div>
  );
}

export function ProposeVignette() {
  return (
    <div className={`${styles.stage} ${styles.propose}`} aria-hidden="true">
      <span className={styles.end}>Agent</span>
      <span className={styles.wire} />
      <span className={styles.packet}>
        <code>propose_trade</code>
        <span className="num">$18.00</span>
      </span>
      <span className={styles.end}>Contract</span>
    </div>
  );
}

export function DecideVignette() {
  return (
    <div className={`${styles.stage} ${styles.decide}`} aria-hidden="true">
      <div className={styles.lamps}>
        <span className={styles.lampRow} data-tone="approved">
          <span className={styles.lamp} />
          Approved
        </span>
        <span className={styles.lampRow} data-tone="held">
          <span className={styles.lamp} />
          Held for you
        </span>
        <span className={styles.lampRow} data-tone="rejected">
          <span className={styles.lamp} />
          Rejected
        </span>
      </div>
    </div>
  );
}
