/**
 * Kiosk Check-In Configuration
 *
 * Barber & tattoo artist data for the reception iPad kiosk.
 * Calendar IDs mirror Constants.swift in the iOS app.
 */

const BARBER_LOCATION_ID = process.env.GHL_BARBER_LOCATION_ID || 'GLRkNAxfPtWTqTiN83xj';

const BARBER_DATA = [
  {
    name: 'Lionel Chavez',
    ghlUserId: '1kFG5FWdUDhXLUX46snG',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/68780cc2204f2d4cf6d61a1d.jpeg',
    calendars: {
      haircut: 'Bsv9ngkRgsbLzgtN3Vpq',
      haircut_beard: 'pGNsYjGyEYW9LCD1GcQN',
      haircut_fnf: '9a66xeZi2pEJWQpxiMjy',
      haircut_beard_fnf: '0qOmPMcP7L4qz58fxmu4',
    },
  },
  {
    name: 'Drew Smith',
    ghlUserId: 'zKiZ5w3ImX0bA7zrFIZx',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/6776135510dd0d56888c6556.jpeg',
    calendars: {
      haircut: 'AzIK0eW09u4V1jJTXQ0x',
      haircut_beard: 'dCuPcZbqylgwftyDu8kw',
      beard_trim: 'RsdMc558Cjjs28xpyCCf',
    },
  },
  {
    name: 'Logan Jensen',
    ghlUserId: 'XrbRTwVGMwgcGOgD2a5n',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/674558dbe0a90824854ccdc9.jpeg',
    calendars: {
      haircut: 'o1fvyti3GnoFGKZN5Hwr',
      haircut_beard: 'lsBgjayKLFOUahMvuVNe',
      beard_trim: 'Us8MYQ74AcvMsJBmIucQ',
    },
  },
  {
    name: 'Elle Gibeau',
    ghlUserId: 'sLkO5CwFrhdcM7EOtTvg',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/67761327b0a11f1886bd0c31.jpeg',
    calendars: {
      haircut: 'Bcqa2hqjUX7xhNu37cL1',
      haircut_beard: 'D9l8VEIX7hOLrqSrSJVc',
    },
  },
  {
    name: 'David Mackflin',
    ghlUserId: '47m7vgAy8cwELwCBE3LT',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/672aff993db84f7fc885c3c0.jpeg',
    calendars: {
      haircut: 'qvcPzTqyaQOxsijIQqAN',
      haircut_beard: 'prLxqGcd2JYNnb0sPGmc',
    },
  },
  {
    name: 'Joshua Flores',
    ghlUserId: 'Dm20lBxWvG393LUoxuEV',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/6752720a988a5fa5209a4c0f.jpeg',
    calendars: {
      haircut: 'X1xINoRML65yAOVUsAGa',
      haircut_beard: 'Vs496YAmFt5uX2JTg2Bs',
      beard_trim: '3NsSPGmWCxSAZJSPTIDY',
    },
  },
  {
    name: 'Liam Meagher',
    ghlUserId: 'GBzpanPloybTcnPEIzpE',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/67a460d2d78c08132ea508a1.jpeg',
    calendars: {
      haircut: 'kiGx7ec1vj9e62U33ZhU',
      haircut_beard: 'vLpnhjAc93piHn1e2cfQ',
      beard_trim: 'g7DSKwGxH8qsXrHBfZ5h',
    },
  },
  {
    name: 'Gilberto Castro',
    ghlUserId: 'F6m7GBKeyIRcehYkubfe',
    photoUrl: 'https://msgsndr-private.storage.googleapis.com/user/F6m7GBKeyIRcehYkubfe/profile/bb4ec4cd-08ec-48d0-8392-5954a87167de.jpg',
    calendars: {
      haircut: '38Uhu6i5W4L5yGJbE0My',
      haircut_beard: '7Bj9t1Gwi0zcJRTwCvYA',
    },
  },
  {
    // Part-time barber — added 2026-05-18. Standard service keys
    // (haircut/haircut_beard) drive the walk-in slot enum; the extra
    // grey_blending/neck_trim keys are for the front-desk dashboard.
    name: 'Anna Kinkead',
    ghlUserId: '7iWsFK2Lao8GNZIawDDx',
    photoUrl: 'https://msgsndr-private.storage.googleapis.com/user/7iWsFK2Lao8GNZIawDDx/profile/a8a4bc70-af11-44e5-9614-15f2fc15a9c7.jpg',
    calendars: {
      haircut: 'WWduImUIgEoEx8mBTkmp',
      haircut_beard: '9s2hYN8XT06IrGGt89uT',
      grey_blending: 'ZOORnQ8ZPwiyT3Xtvvlg',
      neck_trim: 'rsg2VbiVFGuGiEwUIhdl',
    },
  },
  {
    // ⚠️ TEMPORARY TEST BARBER (added 2026-06-22) — "Studio AZ" service account,
    // used for live walk-in booking tests. All-day schedule (08:00–21:00) so it
    // always shows "now" availability. REMOVE this entry + WALK_IN_CALENDARS
    // entry + delete GHL calendar 48a2xaeIgoz2XNMSAwRj when testing is done.
    name: 'Studio AZ (Test)',
    ghlUserId: 'mf1uNeKFJ1hTl1ZEvwjW',
    photoUrl: 'https://msgsndr-private.storage.googleapis.com/user/mf1uNeKFJ1hTl1ZEvwjW/profile/bb1e90b9-7f75-4be0-8cf7-d0c409f45527.png',
    calendars: {
      haircut: '48a2xaeIgoz2XNMSAwRj',
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Walk-In Kiosk calendars (created 2026-06-18)
//
// Dedicated round_robin calendars in the GHL "Walk-In Kiosk" group, each with
// slotInterval=5min and allowBookingAfter=0 (no booking notice), associated to
// the same per-service Schedule as the barber's website calendar. These let a
// walk-in book the next 5-minute mark instantly, while the website calendars
// keep their booking notice. Keyed by GHL userId. Anna Kinkead is intentionally
// excluded from walk-ins (she stays in the "I have an appointment" flow only).
// Source of truth for availability is GHL getSlots on these calendar IDs.
// ─────────────────────────────────────────────────────────────────────────
const WALK_IN_CALENDARS = {
  '1kFG5FWdUDhXLUX46snG': { haircut: 'LpZYqYJEx2JYVMvQopUc', haircut_beard: 'Jg8EbIPhADDjXnEuQ5Kf' }, // Lionel
  'zKiZ5w3ImX0bA7zrFIZx': { haircut: 'S7qAq8CtnLc6JED651WC', haircut_beard: '7ferPTjhyTAE3eSgVZFV', beard_trim: '3zWRBfoaaVvLOBgzicIT' }, // Drew
  'XrbRTwVGMwgcGOgD2a5n': { haircut: '0atF9bwnvNghg5uTuQhe', haircut_beard: 'Jko7lsWVtzYE3HHFb3cC', beard_trim: 'AFSQKhFtOnZcU8c5AmPv' }, // Logan
  'sLkO5CwFrhdcM7EOtTvg': { haircut: 'oiGYuvFPmEdS4mcuQ3ob', haircut_beard: 'zLMuCrTBQEKyzdh6qqbJ' }, // Elle
  '47m7vgAy8cwELwCBE3LT': { haircut: 'fcczrWI11c7PSxCiRjs4', haircut_beard: 'sVAmMQlzK0QSld88bDFi' }, // David
  'Dm20lBxWvG393LUoxuEV': { haircut: 'GHVmOlzYsw2zwUuRlLfg', haircut_beard: '7exK7hfElT52v6kqHhZ4', beard_trim: 'BRpryozDSJaGW2tMEi5q' }, // Joshua
  'GBzpanPloybTcnPEIzpE': { haircut: 'sF0UpmmXPS5X450uUsu8', haircut_beard: '8HLEwHHFaDh13Dfc9yWl', beard_trim: 'STPEOSi9qgn930PiZFtH' }, // Liam
  'F6m7GBKeyIRcehYkubfe': { haircut: 'hU5u8GW0qEyZ1HU2LwlV', haircut_beard: 'BHhhOkDKJTbtKWt0Ppmj' }, // Gilberto
  'mf1uNeKFJ1hTl1ZEvwjW': { haircut: '48a2xaeIgoz2XNMSAwRj' }, // ⚠️ TEMPORARY TEST BARBER — remove after walk-in testing
};

// GHL userIds that are TEST-ONLY walk-in barbers. Hidden from the live kiosk by
// default; only included when the request passes ?includeTest=1 (the preview /
// test website sets that flag). Lets us test on the preview without real clients
// on the live kiosk seeing the test barber. Empty this out when testing is done.
const TEST_WALK_IN_USER_IDS = ['mf1uNeKFJ1hTl1ZEvwjW'];

const TATTOO_LOCATION_ID = process.env.GHL_LOCATION_ID || 'mUemx2jG4wly4kJWBkI4';

const TATTOO_ARTIST_DATA = [
  {
    name: 'Joan Martinez',
    ghlUserId: '1wuLf50VMODExBSJ9xPI',
    calendarId: '0oW0C4kLB6qh1qa1WV9c',
  },
  {
    name: 'Andrew Fernan',
    ghlUserId: 'O8ChoMYj1BmMWJJsDlvC',
    calendarId: '9KwARaShHhymNjgarXgA',
  },
  {
    name: 'Megan Schultz',
    ghlUserId: 'BaSmQL1fkhdjmCYuDRWK',
    calendarId: 'V4BBSwT1ItpeAOvurkA0',
  },
  {
    name: 'Kaelani Azadi',
    ghlUserId: 'C94R2IHBHHf0yuPzBpuS',
    calendarId: 'PPeDpuT3ND8rY57MKVUy',
  },
];

module.exports = { BARBER_DATA, BARBER_LOCATION_ID, TATTOO_ARTIST_DATA, TATTOO_LOCATION_ID, WALK_IN_CALENDARS, TEST_WALK_IN_USER_IDS };
