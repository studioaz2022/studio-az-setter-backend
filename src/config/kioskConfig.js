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
    },
  },
  {
    name: 'Drew Smith',
    ghlUserId: 'zKiZ5w3ImX0bA7zrFIZx',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/6776135510dd0d56888c6556.jpeg',
    calendars: {
      haircut: 'AzIK0eW09u4V1jJTXQ0x',
      haircut_beard: 'dCuPcZbqylgwftyDu8kw',
    },
  },
  {
    name: 'Logan Jensen',
    ghlUserId: 'XrbRTwVGMwgcGOgD2a5n',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/674558dbe0a90824854ccdc9.jpeg',
    calendars: {
      haircut: 'o1fvyti3GnoFGKZN5Hwr',
      haircut_beard: 'lsBgjayKLFOUahMvuVNe',
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
    },
  },
  {
    name: 'Albe Herrera',
    ghlUserId: 'm0i0Q9vfa2YTmxLrrriK',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/674e5a20d9a12ed259a96d7a.jpeg',
    calendars: {
      haircut: 'h9VQL30IBqr6TTiKwAQm',
      haircut_beard: 'NZSQNzPM10Fe6mUuJuyU',
    },
  },
  {
    name: 'Liam Meagher',
    ghlUserId: 'GBzpanPloybTcnPEIzpE',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/67a460d2d78c08132ea508a1.jpeg',
    calendars: {
      haircut: 'kiGx7ec1vj9e62U33ZhU',
      haircut_beard: 'vLpnhjAc93piHn1e2cfQ',
    },
  },
  {
    name: 'Gilberto Castro',
    ghlUserId: 'F6m7GBKeyIRcehYkubfe',
    photoUrl: 'https://storage.googleapis.com/msgsndr/GLRkNAxfPtWTqTiN83xj/media/698a50f6a41b878dfb2300da.jpg',
    calendars: {
      haircut: '38Uhu6i5W4L5yGJbE0My',
      haircut_beard: '7Bj9t1Gwi0zcJRTwCvYA',
    },
  },
];

module.exports = { BARBER_DATA, BARBER_LOCATION_ID };
