import fs from "fs";
import csv from "csv-parser";

import { db } from "./firebase.js";
import { doc, writeBatch } from "firebase/firestore";

const results = [];

// 1. Read CSV file
fs.createReadStream("./data/BTVTED-MT - Sheet1.csv")
  .pipe(csv())
  .on("data", (data) => {
    results.push({
      subjectCode: data.subjectCode,
      subjectName: data.subjectName,

      // FORCE correct program (safer than CSV)
      programCode: "BTVTED-MT",

      majorCode: data.majorCode,

      yearLevel: Number(data.yearLevel || 0),
      semester: Number(data.semester || 0),
      units: Number(data.units || 0),

      lecHours: Number(data.lecHours || 0),
      labHours: Number(data.labHours || 0),

      subjectType: data.subjectType,
      requiredRoomType: data.requiredRoomType,

      prerequisite: data.prerequisite || "",
      meetingType: data.meetingType
    });
  })

  // 2. After CSV is fully read
  .on("end", async () => {
    try {
      let counter = 1;
      let batch = writeBatch(db);
      let batchCount = 0;

      console.log(`Total subjects found: ${results.length}`);

      // 3. Loop all rows
      for (const subject of results) {

        const docId = `BTVTED-MT-${String(counter).padStart(2, "0")}`;

        const docRef = doc(db, "prospectus", docId);

        batch.set(docRef, subject);

        console.log(`Queued: ${docId}`);

        counter++;
        batchCount++;

        // 4. Firestore batch limit = 500 writes
        if (batchCount === 500) {
          await batch.commit();
          console.log("🔥 Batch committed (500 docs)");

          batch = writeBatch(db);
          batchCount = 0;
        }
      }

      // 5. Commit remaining docs
      if (batchCount > 0) {
        await batch.commit();
        console.log("🔥 Final batch committed");
      }

      console.log("✅ BTVTED-MT Import Complete!");

    } catch (error) {
      console.error("❌ Import failed:", error);
    }
  });