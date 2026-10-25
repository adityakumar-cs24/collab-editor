export class LamportClock {
  private value: number;

  constructor(start = 0) {
    this.value = start;
  }

  get current(): number {
    return this.value;
  }

  // Call before each local operation. Returns the new counter.
  tick(): number {
    this.value += 1;
    return this.value;
  }

  // Call when a remote operation with this counter is received.
  observe(remote: number): void {
    if (remote > this.value) this.value = remote;
  }
}
