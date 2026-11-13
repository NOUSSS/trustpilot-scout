/** Limite de débit par client : au plus `max` requêtes par fenêtre de `windowMs`. */
export class RateLimiter {
  constructor({ max, windowMs, maxKeys = 5000 }) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.windows = new Map();
  }

  /**
   * Compte une requête pour `key`.
   * @returns {number} 0 si elle passe, sinon le nombre de secondes à attendre.
   */
  take(key, now = Date.now()) {
    let entry = this.windows.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      // Réinsertion en fin de Map : les fenêtres les plus anciennes sortent les premières.
      this.windows.delete(key);
      this.windows.set(key, entry);
      while (this.windows.size > this.maxKeys) {
        this.windows.delete(this.windows.keys().next().value);
      }
    }
    if (entry.count >= this.max) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    entry.count++;
    return 0;
  }
}
