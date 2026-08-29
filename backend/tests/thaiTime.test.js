/**
 * Thai spoken-time parsing.
 *
 * These are the expressions people actually use when dictating a care plan. A wrong conversion
 * here puts medication at the wrong hour, so the parser is pinned rather than trusted.
 */

import { describe, it, expect } from 'vitest';
import {
  parseThaiTime, extractTimes, normaliseTimes, reconcile, sortByTime, isHHMM,
} from '../src/lib/thaiTime.js';

describe('ตี — early morning', () => {
  const cases = [['ตี 1', '01:00'], ['ตีสอง', '02:00'], ['ตี 3', '03:00'],
    ['ตีห้า', '05:00'], ['ตี 4 ครึ่ง', '04:30']];
  for (const [text, want] of cases) {
    it(`"${text}" → ${want}`, () => expect(parseThaiTime(text)).toBe(want));
  }
});

describe('โมงเช้า — morning', () => {
  const cases = [['8 โมงเช้า', '08:00'], ['เก้าโมงเช้า', '09:00'],
    ['6 โมงเช้า', '06:00'], ['10 โมงเช้าครึ่ง', '10:30'], ['โมงเช้า', '07:00']];
  for (const [text, want] of cases) {
    it(`"${text}" → ${want}`, () => expect(parseThaiTime(text)).toBe(want));
  }
});

describe('เที่ยง — noon and midnight', () => {
  it('เที่ยง → 12:00', () => expect(parseThaiTime('เที่ยง')).toBe('12:00'));
  it('เที่ยงวัน → 12:00', () => expect(parseThaiTime('เที่ยงวัน')).toBe('12:00'));
  it('เที่ยงตรง → 12:00', () => expect(parseThaiTime('เที่ยงตรง')).toBe('12:00'));
  it('เที่ยงคืน → 00:00', () => expect(parseThaiTime('เที่ยงคืน')).toBe('00:00'));
  it('เที่ยงคืน is not read as เที่ยง', () =>
    expect(parseThaiTime('พาเข้านอนตอนเที่ยงคืน')).toBe('00:00'));
});

describe('บ่าย — afternoon', () => {
  const cases = [['บ่ายโมง', '13:00'], ['บ่าย 2', '14:00'], ['บ่ายสอง', '14:00'],
    ['บ่าย 3 โมง', '15:00'], ['บ่ายสี่', '16:00'], ['บ่ายโมงครึ่ง', '13:30']];
  for (const [text, want] of cases) {
    it(`"${text}" → ${want}`, () => expect(parseThaiTime(text)).toBe(want));
  }
});

describe('โมงเย็น — evening', () => {
  const cases = [['4 โมงเย็น', '16:00'], ['5 โมงเย็น', '17:00'],
    ['หกโมงเย็น', '18:00'], ['โมงเย็น', '18:00']];
  for (const [text, want] of cases) {
    it(`"${text}" → ${want}`, () => expect(parseThaiTime(text)).toBe(want));
  }
});

describe('ทุ่ม — night', () => {
  const cases = [['1 ทุ่ม', '19:00'], ['ทุ่มนึง', '19:00'], ['สองทุ่ม', '20:00'],
    ['3 ทุ่ม', '21:00'], ['5 ทุ่ม', '23:00'], ['2 ทุ่มครึ่ง', '20:30']];
  for (const [text, want] of cases) {
    it(`"${text}" → ${want}`, () => expect(parseThaiTime(text)).toBe(want));
  }
});

describe('numeric forms already in the text', () => {
  it('13:30 stays', () => expect(parseThaiTime('13:30')).toBe('13:30'));
  it('09.15 น. → 09:15', () => expect(parseThaiTime('09.15 น.')).toBe('09:15'));
  it('14 นาฬิกา → 14:00', () => expect(parseThaiTime('14 นาฬิกา')).toBe('14:00'));
});

describe('whole sentences', () => {
  it('finds every time in order', () => {
    const s = 'แปดโมงเช้าอาบน้ำ เที่ยงป้อนข้าว บ่ายโมงให้ยา แล้ว 2 ทุ่มพาเข้านอน';
    expect(extractTimes(s).map((t) => t.time)).toEqual(['08:00', '12:00', '13:00', '20:00']);
  });

  it('rewrites spoken times to HH:MM and leaves the rest alone', () => {
    const out = normaliseTimes('บ่ายโมงให้ยาเบาหวาน');
    expect(out).toBe('13:00ให้ยาเบาหวาน');
  });

  it('a sentence with no time yields nothing', () => {
    expect(extractTimes('ช่วยดูแลทั่วไป')).toEqual([]);
    expect(parseThaiTime('ช่วยดูแลทั่วไป')).toBeNull();
  });

  it('the classic dictation from the spec parses end to end', () => {
    const s = 'ตอนเช้า 8 โมงอาบน้ำ 11 โมงให้ยาเบาหวาน เที่ยงป้อนข้าว บ่าย 3 พาเดิน 6 โมงเย็นอาบน้ำอีกรอบ';
    expect(extractTimes(s).map((t) => t.time)).toEqual(['08:00', '11:00', '12:00', '15:00', '18:00']);
  });
});

describe('reconcile — the model is checked, not trusted', () => {
  it('repairs a malformed time from the source sentence', () => {
    const { items, corrections } = reconcile(
      [{ title: 'อาบน้ำ', time: 'ตอนเช้า', raw_time: '8 โมงเช้า' }],
      '8 โมงเช้าอาบน้ำ',
    );
    expect(items[0].time).toBe('08:00');
    expect(corrections).toHaveLength(1);
  });

  it('overrides a valid but wrong time when the sentence is unambiguous', () => {
    const { items, corrections } = reconcile(
      [{ title: 'ให้ยา', time: '01:00', raw_time: 'บ่ายโมง' }],
      'บ่ายโมงให้ยา',
    );
    expect(items[0].time).toBe('13:00');
    expect(corrections[0].to).toBe('13:00');
  });

  it('leaves a correct time untouched', () => {
    const { items, corrections } = reconcile(
      [{ title: 'ให้ยา', time: '13:00', raw_time: 'บ่ายโมง' }],
      'บ่ายโมงให้ยา',
    );
    expect(items[0].time).toBe('13:00');
    expect(corrections).toHaveLength(0);
  });

  it('a time it cannot recover becomes null rather than a guess', () => {
    const { items } = reconcile([{ title: 'ทำความสะอาด', time: 'ไม่แน่ใจ' }], 'ทำความสะอาดบ้าน');
    expect(items[0].time).toBeNull();
  });
});

describe('sortByTime', () => {
  it('orders a day chronologically with untimed entries last', () => {
    const out = sortByTime([
      { title: 'c', time: '18:00' }, { title: 'x', time: null },
      { title: 'a', time: '08:00' }, { title: 'b', time: '13:00' },
    ]);
    expect(out.map((i) => i.title)).toEqual(['a', 'b', 'c', 'x']);
  });
});

describe('isHHMM', () => {
  it('accepts real times only', () => {
    expect(isHHMM('00:00')).toBe(true);
    expect(isHHMM('23:59')).toBe(true);
    expect(isHHMM('24:00')).toBe(false);
    expect(isHHMM('9:00')).toBe(false);
    expect(isHHMM('บ่ายโมง')).toBe(false);
  });
});
