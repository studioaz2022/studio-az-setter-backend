require("dotenv").config();
const { gridWalkUtilization } = require("../src/analytics/gridWalkUtilization");

const checks = [
  // Format: [name, ghlUserId, dateStr, "context note"]
  ["Logan", "XrbRTwVGMwgcGOgD2a5n", "2026-02-11", "complex multi-cal"],
  ["Logan", "XrbRTwVGMwgcGOgD2a5n", "2026-02-17", "with manual blocks"],
  ["Liam", "GBzpanPloybTcnPEIzpE", "2026-02-05", "30-min gap dead space"],
  ["Liam", "GBzpanPloybTcnPEIzpE", "2026-02-20", "cancellations"],
  ["Liam", "GBzpanPloybTcnPEIzpE", "2026-02-21", "tight 60min HC starts"],
  ["Drew", "zKiZ5w3ImX0bA7zrFIZx", "2026-03-12", "random Thu"],
  ["Drew", "zKiZ5w3ImX0bA7zrFIZx", "2026-04-05", "random Sun"],
  ["Joshua", "Dm20lBxWvG393LUoxuEV", "2026-03-15", "random Sun"],
  ["Joshua", "Dm20lBxWvG393LUoxuEV", "2026-04-10", "random Fri"],
  ["David", "47m7vgAy8cwELwCBE3LT", "2026-04-22", "post-fix verification"],
  ["David", "47m7vgAy8cwELwCBE3LT", "2026-04-25", "random Sat"],
  ["Lionel", "1kFG5FWdUDhXLUX46snG", "2026-03-03", "March 3 dead space"],
  ["Lionel", "1kFG5FWdUDhXLUX46snG", "2026-02-25", "Feb 25 with manual block"],
  ["Albe", "m0i0Q9vfa2YTmxLrrriK", "2026-02-03", "external sync 18 'blocks'"],
  ["Albe", "m0i0Q9vfa2YTmxLrrriK", "2026-02-14", "Valentine's Day"],
];

(async () => {
  console.log("Barber   Date         Day  Sched  Occ  Free  Blk  Sync  OT  Cxl   NoSh  Util%  Mix%  Mode         Note");
  console.log("─".repeat(120));
  for (const [name, id, date, note] of checks) {
    try {
      const r = await gridWalkUtilization({ barberGhlUserId: id, dateStr: date });
      if (!r) {
        console.log(`${name.padEnd(8)} ${date}   off  (no schedule for that day)`);
        continue;
      }
      console.log(
        name.padEnd(8) + " " +
        r.dateStr + "  " +
        r.dayName.slice(0, 3) + "  " +
        String(r.scheduledSlots).padStart(5) + "  " +
        String(r.occupied).padStart(3) + "  " +
        String(r.free).padStart(4) + "  " +
        String(r.manuallyBlocked).padStart(3) + "  " +
        String(r.syncedAppointmentCount + r.informalAppointmentCount).padStart(4) + "  " +
        String(r.overtimeSlots).padStart(2) + "  " +
        String(r.cancelledCount).padStart(3) + "   " +
        String(r.noshowCount).padStart(3) + "   " +
        String(r.utilization).padStart(5) + "  " +
        String(r.serviceMixEfficiency).padStart(4) + "  " +
        r.mode.padEnd(11) + "  " +
        note,
      );
    } catch (err) {
      console.log(`${name.padEnd(8)} ${date}   ERROR: ${err.message}`);
    }
  }
})().catch((err) => { console.error("Fatal:", err); process.exit(1); });
