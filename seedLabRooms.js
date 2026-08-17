/**
 * seedLabRooms.js
 *
 * Adds specific laboratory rooms (FSM, AT, MT, CT, ELT, ELX, CP, CPT)
 * to Firebase Firestore so the scheduler can match them by roomType.
 *
 * Usage: node seedLabRooms.js
 */

import { db } from "./firebase.js";
import { doc, setDoc } from "firebase/firestore";

const labRooms = [
  {
    roomCode: "FSML01",
    roomName: "FSM Laboratory",
    roomType: "FSM Laboratory",
    capacity: 40,
    building: "Building A",
    floor: 1,
    status: "AVAILABLE"
  },
  {
    roomCode: "ATL01",
    roomName: "AT Laboratory",
    roomType: "AT Laboratory",
    capacity: 40,
    building: "Building A",
    floor: 1,
    status: "AVAILABLE"
  },
  {
    roomCode: "MTL01",
    roomName: "MT Laboratory",
    roomType: "MT Laboratory",
    capacity: 40,
    building: "Building A",
    floor: 1,
    status: "AVAILABLE"
  },
  {
    roomCode: "CTL01",
    roomName: "CT Laboratory",
    roomType: "CT Laboratory",
    capacity: 40,
    building: "Building A",
    floor: 1,
    status: "AVAILABLE"
  },
  {
    roomCode: "ELTL01",
    roomName: "ELT Laboratory",
    roomType: "ELT Laboratory",
    capacity: 40,
    building: "Building A",
    floor: 1,
    status: "AVAILABLE"
  },
  {
    roomCode: "ELXL01",
    roomName: "ELX Laboratory",
    roomType: "ELX Laboratory",
    capacity: 40,
    building: "Building A",
    floor: 1,
    status: "AVAILABLE"
  },
  {
    roomCode: "CPL01",
    roomName: "CP Laboratory",
    roomType: "CP Laboratory",
    capacity: 40,
    building: "Building A",
    floor: 1,
    status: "AVAILABLE"
  },
  {
    roomCode: "CPTL01",
    roomName: "CPT Laboratory",
    roomType: "CPT Laboratory",
    capacity: 40,
    building: "Building A",
    floor: 1,
    status: "AVAILABLE"
  }
];

async function seed() {
  for (const room of labRooms) {
    await setDoc(doc(db, "rooms", room.roomCode), room);
    console.log(`Seeded: ${room.roomCode} (${room.roomType})`);
  }

  console.log("\nAll laboratory rooms seeded successfully!");
  process.exit(0);
}

seed().catch(error => {
  console.error("Seeding failed:", error);
  process.exit(1);
});

