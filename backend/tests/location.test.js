/**
 * Location disclosure.
 *
 * The rule being tested is a privacy boundary, not a formatting detail: before a caregiver is
 * accepted they get an area, afterwards they get the address. A regression here leaks a household's
 * exact position to every caregiver who happens to be shown the job.
 */

import { describe, it, expect } from 'vitest';
import {
  approximate, exact, locationFor, distanceMetres, insideGeofence, APPROX_RADIUS_M,
} from '../src/lib/location.js';

const YALA = { latitude: 6.5412345, longitude: 101.2801234, geofence_radius_m: 150 };

describe('approximate — an area, not an address', () => {
  it('rounds the centre away from the exact point', () => {
    const a = approximate(YALA.latitude, YALA.longitude);
    expect(a.latitude).not.toBe(YALA.latitude);
    expect(a.longitude).not.toBe(YALA.longitude);
    expect(a.precision).toBe('APPROXIMATE');
    expect(a.radius_m).toBe(APPROX_RADIUS_M);
  });

  it('is deterministic — the same house always yields the same circle', () => {
    const a = approximate(YALA.latitude, YALA.longitude);
    const b = approximate(YALA.latitude, YALA.longitude);
    expect(a).toEqual(b);
  });

  it('keeps the real point inside the circle it shows', () => {
    const a = approximate(YALA.latitude, YALA.longitude);
    const off = distanceMetres(
      { lat: a.latitude, lng: a.longitude },
      { lat: YALA.latitude, lng: YALA.longitude },
    );
    expect(off).toBeLessThan(a.radius_m);
  });

  it('two nearby houses can share a circle, which is the point', () => {
    const a = approximate(6.5412, 101.2801);
    const b = approximate(6.5414, 101.2803);
    expect(a.latitude).toBe(b.latitude);
    expect(a.longitude).toBe(b.longitude);
  });

  it('returns null for a missing coordinate rather than a bogus one', () => {
    expect(approximate(undefined, 101)).toBeNull();
    expect(approximate(6.5, null)).toBeNull();
  });
});

describe('exact — the real pin plus the geofence', () => {
  it('preserves the coordinate and the configured radius', () => {
    const e = exact(YALA.latitude, YALA.longitude, 200);
    expect(e.latitude).toBeCloseTo(YALA.latitude, 5);
    expect(e.radius_m).toBe(200);
    expect(e.precision).toBe('EXACT');
  });

  it('falls back to 150 m when no radius is configured', () => {
    expect(exact(6.5, 101.2).radius_m).toBe(150);
  });
});

describe('locationFor — who sees what, and when', () => {
  it('the family always sees their own exact location', () => {
    expect(locationFor(YALA, 'FAMILY').precision).toBe('EXACT');
  });

  it('a caregiver who has not been accepted sees only an area', () => {
    const l = locationFor(YALA, 'CAREGIVER', false);
    expect(l.precision).toBe('APPROXIMATE');
    expect(l.latitude).not.toBe(YALA.latitude);
  });

  it('an accepted caregiver sees the exact location and the geofence', () => {
    const l = locationFor(YALA, 'CAREGIVER', true);
    expect(l.precision).toBe('EXACT');
    expect(l.latitude).toBeCloseTo(YALA.latitude, 5);
    expect(l.radius_m).toBe(150);
  });
});

describe('geofence arithmetic', () => {
  it('measures a short distance sensibly', () => {
    const d = distanceMetres({ lat: 6.5410, lng: 101.2800 }, { lat: 6.5410, lng: 101.2810 });
    expect(d).toBeGreaterThan(90);
    expect(d).toBeLessThan(130);
  });

  it('a point at the care location is inside', () => {
    expect(insideGeofence({ lat: YALA.latitude, lng: YALA.longitude }, YALA)).toBe(true);
  });

  it('a point a kilometre away is outside', () => {
    expect(insideGeofence({ lat: YALA.latitude + 0.01, lng: YALA.longitude }, YALA)).toBe(false);
  });

  it('unknown inputs give null rather than a false negative', () => {
    expect(insideGeofence(null, YALA)).toBeNull();
    expect(insideGeofence({ lat: 6.5, lng: 101 }, null)).toBeNull();
  });
});
