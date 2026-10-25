export type NaiveOp =
  | { type: "insert"; index: number; char: string }
  | { type: "delete"; index: number };

// A text replica that identifies positions by integer index.
// This is the "obvious" design, and it is broken under concurrency.
export class NaiveReplica {
  text: string;

  constructor(initial = "") {
    this.text = initial;
  }

  apply(op: NaiveOp): void {
    if (op.type === "insert") {
      this.text = this.text.slice(0, op.index) + op.char + this.text.slice(op.index);
    } else {
      this.text = this.text.slice(0, op.index) + this.text.slice(op.index + 1);
    }
  }
}
