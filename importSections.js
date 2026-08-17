import fs from "fs";
import csv from "csv-parser";
import { collection, doc, setDoc } from "firebase/firestore";
import { db } from "./firebase.js";

const results = [];

fs.createReadStream("./data/SECTIONS - Sheet1.csv")
  .pipe(csv())
  .on("data", (data) => {
    results.push(data);
  })
  .on("end", async () => {
    try {
      for (const row of results) {
        await setDoc(
          doc(collection(db, "sections"), row.sectionCode),
          {
            sectionCode: row.sectionCode,
            programCode: row.programCode,
            majorCode: row.majorCode,
            yearLevel: Number(row.yearLevel),
            studentCount: Number(row.studentCount),
            active: row.active.toUpperCase() === "TRUE"
          }
        );

        console.log(`✔ Imported: ${row.sectionCode}`);
      }

      console.log("✅ Sections import completed!");
      process.exit();
    } catch (error) {
      console.error("❌ Import failed:", error);
    }
  });