import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

type Shape = {
  /** Stroked paths. */
  d?: string[];
  /** Stroked circles: cx, cy, r. */
  c?: [number, number, number][];
  /** Filled dots: cx, cy, r. */
  dot?: [number, number, number][];
  /** Stroked rounded rectangles: x, y, width, height, radius. */
  r?: [number, number, number, number, number][];
};

/** The icons of the design, on its 20 by 20 grid. Stroke only, so each takes the colour of its text. */
const SHAPES: Record<string, Shape> = {
  back: { d: ['M12.5 4.5L7 10l5.5 5.5'] },
  chevron: { d: ['M7.5 4.5L13 10l-5.5 5.5'] },
  gear: { c: [[10, 10, 2.6]], d: ['M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4'] },
  plus: { d: ['M10 4v12M4 10h12'] },
  x: { d: ['M6 6l8 8M14 6l-8 8'] },
  terminal: { r: [[3, 4, 14, 12, 2.5]], d: ['M6.5 8.5L9 10.5l-2.5 2M11 12.5h3'] },
  dots: { dot: [[5, 10, 1.3], [10, 10, 1.3], [15, 10, 1.3]] },
  check: { d: ['M5 10.5l3 3 7-7'] },
  copy: { r: [[7, 7, 9, 9, 2]], d: ['M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7'] },
  shield: { d: ['M10 3l6 2.2v4.3c0 3.6-2.6 6-6 7.5-3.4-1.5-6-3.9-6-7.5V5.2z'] },
  issue: { c: [[10, 10, 6.5]], dot: [[10, 10, 1.4]] },
  pr: { c: [[6, 5, 2], [6, 15, 2], [14, 15, 2]], d: ['M6 7v6M14 13V9.5A3.5 3.5 0 0 0 10.5 6H9', 'M10.5 4L8.5 6l2 2'] },
  link: { d: ['M8.5 11.5l3-3M7 9.5L5.6 10.9a2.8 2.8 0 0 0 4 4L11 13.5M13 10.5l1.4-1.4a2.8 2.8 0 0 0-4-4L9 6.5'] },
  now: { c: [[10, 10, 6.5]], dot: [[10, 10, 2.2]] },
  ci: { d: ['M4 10a6 6 0 0 1 10.2-4.3M16 10a6 6 0 0 1-10.2 4.3', 'M14.5 3v3h-3M5.5 17v-3h3'] },
  offline: { d: ['M3 8.5a10 10 0 0 1 14 0M5.5 11a6.5 6.5 0 0 1 9 0M8 13.5a3 3 0 0 1 4 0', 'M3 3l14 14'] },
  resume: { d: ['M4.5 10a5.5 5.5 0 1 0 1.8-4.1', 'M4 3.5v3.2h3.2'] },
  rename: { d: ['M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z'] },
  bell: { d: ['M5.5 8.5a4.5 4.5 0 0 1 9 0c0 4 1.8 5.3 1.8 5.3H3.7s1.8-1.3 1.8-5.3z', 'M8.3 16.5a1.8 1.8 0 0 0 3.4 0'] },
  server: { r: [[3.5, 4, 13, 5, 1.5], [3.5, 11, 13, 5, 1.5]], d: ['M6.5 6.5h.01M6.5 13.5h.01'] },
};

export type IconName = keyof typeof SHAPES;

@Component({
  selector: 'hares-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      @for (d of shape().d ?? []; track $index) { <path [attr.d]="d" /> }
      @for (c of shape().c ?? []; track $index) { <circle [attr.cx]="c[0]" [attr.cy]="c[1]" [attr.r]="c[2]" /> }
      @for (r of shape().r ?? []; track $index) { <rect [attr.x]="r[0]" [attr.y]="r[1]" [attr.width]="r[2]" [attr.height]="r[3]" [attr.rx]="r[4]" /> }
      @for (c of shape().dot ?? []; track $index) { <circle [attr.cx]="c[0]" [attr.cy]="c[1]" [attr.r]="c[2]" fill="currentColor" stroke="none" /> }
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(20);
  protected readonly shape = computed(() => SHAPES[this.name()]);
}
