import fs from "fs";
import csv from "csv-parser";

import { db } from "./firebase.js";

import {
  doc,
  setDoc
} from "firebase/firestore";

const results = [];

fs.createReadStream("./data/ROOM - Sheet1.csv")
  .pipe(csv())
  .on("data", (data) => {

    results.push({
      roomCode: data.roomCode,
      roomName: data.roomName,
      roomType: data.roomType,
      capacity: Number(data.capacity),
      building: data.building,
      floor: Number(data.floor),
      status: data.status
    });

  })
  .on("end", async () => {

    try {

      for (const room of results) {

        await setDoc(
          doc(db, "rooms", room.roomCode), // A101, B204, CET01, etc.
          room
        );

        console.log(`Imported: ${room.roomCode}`);
      }

      console.log("Rooms Import Complete!");

    } catch (error) {

      console.error("Import Error:", error);

    }

  });