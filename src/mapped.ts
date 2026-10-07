// A string that remembers where each part of it came from in the source.
//
// The transpiler builds its output by appending three kinds of pieces:
// - copy(): source text copied verbatim. Positions map exactly.
// - gen():  generated text, attributed to one source position (the pattern,
//           guard or arm that produced it).
// - add():  another Mapped, e.g. a translated arm body.
// originalPos() then turns an offset in the output back into a source offset,
// which is how TypeScript errors in generated code are reported against the
// .tsa file.

interface Segment {
  out: number;
  len: number;
  src: number;
  exact: boolean;
}

export class Mapped {
  text = "";
  private segs: Segment[] = [];

  copy(src: string, start: number, end: number): this {
    if (end > start) {
      this.segs.push({ out: this.text.length, len: end - start, src: start, exact: true });
      this.text += src.slice(start, end);
    }
    return this;
  }

  gen(s: string, anchor: number): this {
    if (s) {
      this.segs.push({ out: this.text.length, len: s.length, src: anchor, exact: false });
      this.text += s;
    }
    return this;
  }

  add(m: Mapped): this {
    const base = this.text.length;
    for (const s of m.segs) this.segs.push({ ...s, out: s.out + base });
    this.text += m.text;
    return this;
  }

  /** Source offset for an output offset, or null if the output is empty. */
  originalPos(outPos: number): number | null {
    let lo = 0;
    let hi = this.segs.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segs[mid].out <= outPos) lo = mid;
      else hi = mid - 1;
    }
    const s = this.segs[lo];
    if (!s.exact) return s.src;
    return s.src + Math.min(Math.max(outPos - s.out, 0), s.len);
  }
}
