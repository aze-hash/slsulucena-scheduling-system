// Functional test harness for canUseLectureRoomForLabSubject (extracted from frontend/class.js)
const fs = require("fs");
const src = fs.readFileSync("frontend/class.js", "utf8");
const start = src.indexOf("function canUseLectureRoomForLabSubject");
const end = src.indexOf("function getBuildingPriority");
if (start < 0 || end < 0 || end <= start) { console.error("extract failed"); process.exit(1); }
const fnSrc = src.slice(start, end);

// ---- stubs mirroring class.js behavior ----
function normalizeRoomType(roomType) {
    if (!roomType) return "";
    const type = String(roomType || "").trim();
    if (type.toLowerCase().includes("gym")) return "Gymnasium";
    const labTypes = ["Laboratory","MT Laboratory","AT Laboratory","CP Laboratory","CT Laboratory","ELT Laboratory","ELX Laboratory","FSM Laboratory","CPT Laboratory"];
    if (labTypes.includes(type)) return type;
    return "Lecture Room";
}
function isLabRoomType(roomType) {
    return ["Laboratory","MT Laboratory","AT Laboratory","CP Laboratory","CT Laboratory","ELT Laboratory","ELX Laboratory","FSM Laboratory","CPT Laboratory"].includes(roomType);
}
function isActivityGymOrCourtRoom(name) { return /gym|court/i.test(String(name || "")); }
function sameRoom(a, b) { return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(); }
function normalizeDayName(d) {
    const map = { mon: "Monday", monday: "Monday", tue: "Tuesday", tuesday: "Tuesday", wed: "Wednesday", wednesday: "Wednesday", thu: "Thursday", thursday: "Thursday", fri: "Friday", friday: "Friday" };
    const clean = String(d || "").trim().toLowerCase();
    return map[clean] || (clean.charAt(0).toUpperCase() + clean.slice(1));
}
function toMin(t) {
    const m = String(t).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;
    let h = parseInt(m[1], 10); const min = parseInt(m[2] || "0", 10);
    const ap = (m[3] || "").toLowerCase();
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return h * 60 + min;
}
function parseTimeRange(rangeStr) {
    const parts = String(rangeStr || "").split("-");
    if (parts.length !== 2) return null;
    const s = toMin(parts[0]), e = toMin(parts[1]);
    if (s === null || e === null || e <= s) return null;
    return { start: s, end: e };
}
function timesOverlap(t1, t2) {
    const a = parseTimeRange(t1), b = parseTimeRange(t2);
    if (!a || !b) return false;
    return a.start < b.end && b.start < a.end;
}
const allRooms_list = [];
const factory = new Function(
    "normalizeRoomType", "isLabRoomType", "isActivityGymOrCourtRoom", "sameRoom",
    "normalizeDayName", "parseTimeRange", "timesOverlap", "allRooms",
    fnSrc + "\nreturn canUseLectureRoomForLabSubject;"
);
const canUse = factory(normalizeRoomType, isLabRoomType, isActivityGymOrCourtRoom, sameRoom, normalizeDayName, parseTimeRange, timesOverlap, allRooms_list);

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const ok = actual === expected;
    console.log(`${ok ? "PASS" : "FAIL"} - ${label} (got ${actual}, expected ${expected})`);
    ok ? pass++ : fail++;
}


// Scenario setup: 1 lecture room + 2 labs
allRooms_list.push(
    { roomName: "Room AVR", roomType: "Lecture Room" },
    { roomName: "CPT Lab 1", roomType: "CPT Laboratory" },
    { roomName: "CPT Lab 2", roomType: "Laboratory" }
);

const bookingsBothLabsBooked = [
    { room: "CPT Lab 1", day: "Monday", time: "1:30-3:00" },
    { room: "CPT Lab 2", day: "Monday", time: "1:30-3:00" }
];
const bookingsOneLabBooked = [
    { room: "CPT Lab 1", day: "Monday", time: "1:30-3:00" }
];

check("All labs booked -> lecture room fallback ALLOWED",
    canUse("Room AVR", "Laboratory", "Monday", "1:30-3:00", bookingsBothLabsBooked), true);
check("A lab is still free -> fallback NOT allowed (conflict stays)",
    canUse("Room AVR", "Laboratory", "Monday", "1:30-3:00", bookingsOneLabBooked), false);
check("No bookings at all -> fallback NOT allowed",
    canUse("Room AVR", "Laboratory", "Monday", "1:30-3:00", []), false);
check("Assigned room is itself a lab -> never fallback",
    canUse("CPT Lab 1", "Laboratory", "Monday", "1:30-3:00", bookingsBothLabsBooked), false);
check("Expected type is Lecture Room -> never fallback",
    canUse("Room AVR", "Lecture Room", "Monday", "1:30-3:00", bookingsBothLabsBooked), false);
check("Expected type is Gymnasium -> never fallback",
    canUse("Room AVR", "Gymnasium", "Monday", "1:30-3:00", bookingsBothLabsBooked), false);
check("Different day (labs free that day) -> fallback NOT allowed",
    canUse("Room AVR", "Laboratory", "Tuesday", "1:30-3:00", bookingsBothLabsBooked), false);
check("Overlapping-but-not-equal time still counts as booked",
    canUse("Room AVR", "Laboratory", "Monday", "2:00-3:30", bookingsBothLabsBooked), true);
check("TBA room -> false",
    canUse("TBA", "Laboratory", "Monday", "1:30-3:00", bookingsBothLabsBooked), false);
check("Invalid time -> false",
    canUse("Room AVR", "Laboratory", "Monday", "garbage", bookingsBothLabsBooked), false);

// Scenario: no labs exist in the system at all
allRooms_list.length = 0;
allRooms_list.push({ roomName: "Room AVR", roomType: "Lecture Room" });
check("No laboratories exist at all -> fallback ALLOWED",
    canUse("Room AVR", "Laboratory", "Monday", "1:30-3:00", []), true);

// Scenario: all labs under maintenance -> fallback ALLOWED
allRooms_list.length = 0;
allRooms_list.push(
    { roomName: "Room AVR", roomType: "Lecture Room" },
    { roomName: "CPT Lab 1", roomType: "CPT Laboratory", status: "MAINTENANCE" }
);
check("Only lab is under maintenance -> fallback ALLOWED",
    canUse("Room AVR", "Laboratory", "Monday", "1:30-3:00", []), true);

// Scenario: specialized expected type with a general lab free
allRooms_list.length = 0;
allRooms_list.push(
    { roomName: "Room AVR", roomType: "Lecture Room" },
    { roomName: "CPT Lab 1", roomType: "CPT Laboratory" },
    { roomName: "General Lab", roomType: "Laboratory" }
);
check("Specialized lab booked but general lab free -> fallback NOT allowed",
    canUse("Room AVR", "CPT Laboratory", "Monday", "1:30-3:00", [{ room: "CPT Lab 1", day: "Monday", time: "1:30-3:00" }]), false);
check("Specialized + general labs both booked -> fallback ALLOWED",
    canUse("Room AVR", "CPT Laboratory", "Monday", "1:30-3:00", [
        { room: "CPT Lab 1", day: "Monday", time: "1:30-3:00" },
        { room: "General Lab", day: "Monday", time: "1:30-3:00" }
    ]), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
