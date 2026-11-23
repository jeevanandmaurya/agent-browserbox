import { describe, expect, it } from 'vitest';
import { nextRunAfter } from '../packages/agent/src/schedule';

const at = (s: string) => new Date(s).getTime();
const iso = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

describe('when a schedule fires next', () => {
  it('daily, hourly and every N minutes (at least 15)', () => {
    expect(iso(nextRunAfter({ every: 'day', at: '08:30' }, at('2026-11-23T07:00:00')))).toBe('2026-11-23 08:30');
    expect(iso(nextRunAfter({ every: 'day', at: '08:30' }, at('2026-11-23T08:30:00')))).toBe('2026-11-24 08:30');
    expect(iso(nextRunAfter({ every: 'hour', minute: 5 }, at('2026-11-23T10:05:00')))).toBe('2026-11-23 11:05');
    expect(nextRunAfter({ every: 'minutes', minutes: 5 }, 0)).toBe(15 * 60_000);
  });

  it('weekdays skip the weekend; weekly lands on its day', () => {
    // 2026-11-27 is a Friday.
    expect(iso(nextRunAfter({ every: 'weekday', at: '09:00' }, at('2026-11-27T10:00:00')))).toBe('2026-11-30 09:00');
    expect(iso(nextRunAfter({ every: 'week', day: 3, at: '18:00' }, at('2026-11-23T12:00:00')))).toBe('2026-11-25 18:00');
  });
});
