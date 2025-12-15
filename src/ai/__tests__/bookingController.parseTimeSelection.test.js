const { parseTimeSelection } = require("../bookingController");

describe("parseTimeSelection (unique matches)", () => {
  const slots = [
    {
      startTime: "2025-12-16T17:00:00.000Z", // Tuesday
      endTime: "2025-12-16T17:30:00.000Z",
      displayText: "Tue 5:00 PM",
    },
    {
      startTime: "2025-12-17T17:00:00.000Z", // Wednesday
      endTime: "2025-12-17T17:30:00.000Z",
      displayText: "Wed 5:00 PM",
    },
  ];

  test("selects unique weekday mention without time", () => {
    const idx = parseTimeSelection("I can do Tuesday", slots);
    expect(idx).toBe(0);
  });

  test("selects unique day-of-month mention without time", () => {
    const idx = parseTimeSelection("the 16th works", slots);
    expect(idx).toBe(0);
  });
});

