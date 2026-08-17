import fs from "fs";
import csv from "csv-parser";

import { db } from "./firebase.js";
import { doc, getDoc, setDoc, collection } from "firebase/firestore";

const results = [];

// 👉 CHANGE THIS per CSV file
const FILE_PREFIX = "BIT-CPT";

let counter = 1;

// Generate custom ID: BIT-CPT-01, BIT-CPT-02...
function generateID() {
  return `${FILE_PREFIX}-${String(counter).padStart(2, "0")}`;
}

fs.createReadStream("./data/BIT-CPT - Sheet1.csv")
  .pipe(csv())
  .on("data", (data) => {
    results.push({
      subjectCode: data.subjectCode,
      subjectName: data.subjectName,
      programCode: data.programCode,
      majorCode: data.majorCode,

      yearLevel: data.yearLevel ? Number(data.yearLevel) : 0,
      semester: data.semester ? Number(data.semester) : 0,
      units: data.units ? Number(data.units) : 0,
      lecHours: data.lecHours ? Number(data.lecHours) : 0,
      labHours: data.labHours ? Number(data.labHours) : 0,

      subjectType: data.subjectType || "",
      requiredRoomType: data.requiredRoomType || "",
      prerequisite: data.prerequisite || "",
      meetingType: data.meetingType || ""
    });
  })
  .on("end", async () => {
    console.log(`Starting import for ${FILE_PREFIX}...`);

    try {
      for (const subject of results) {

        const id = generateID();

        const ref = doc(db, "prospectus", id);
        const existing = await getDoc(ref);

        // Prevent duplicate if re-run
        if (existing.exists()) {
          console.log(`Skipped ${id} (already exists)`);
          counter++;
          continue;
        }

        await setDoc(ref, subject);

        console.log(`Imported: ${id} → ${subject.subjectCode}`);

        counter++;
      }

      console.log("✅ Import Complete!");

    } catch (error) {
      console.error("❌ Import failed:", error);
    }
  });