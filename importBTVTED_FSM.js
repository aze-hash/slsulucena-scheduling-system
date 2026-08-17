import fs from "fs";
import csv from "csv-parser";

import { db } from "./firebase.js";

import {
  doc,
  setDoc
} from "firebase/firestore";

const results = [];

fs.createReadStream("./data/BTVTED-FSM - Sheet1.csv")
  .pipe(csv())
  .on("data", (data) => {

    results.push({
      subjectCode: data.subjectCode,
      subjectName: data.subjectName,

      programCode: "BTVTED",
      majorCode: "FSM",

      yearLevel: Number(data.yearLevel),
      semester: Number(data.semester),
      units: Number(data.units),

      lecHours: Number(data.lecHours),
      labHours: Number(data.labHours),

      subjectType: data.subjectType,
      requiredRoomType: data.requiredRoomType,

      prerequisite: data.prerequisite || "",

  
      meetingType: data.meetingType || data.meetingType
    });

  })
  .on("end", async () => {

    try {

      let counter = 1;

      for (const subject of results) {

        const docId =
          `BTVTED-FSM-${String(counter).padStart(2, "0")}`;

        await setDoc(
          doc(db, "prospectus", docId),
          subject
        );

        console.log(`Imported: ${docId}`);

        counter++;
      }

      console.log("BTVTED-FSM Import Complete!");

    } catch (error) {

      console.error(error);

    }

  });