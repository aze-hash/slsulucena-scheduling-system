# Report Storage - PDF Reports Feature

## Goal
Create a Report page that stores exported class schedule and exam schedule PDFs in Firestore, displayed separately by category.

## Steps

- [x] Create `frontend/reportStorage.js` — `saveReportToFirestore()` + `loadReportsFromFirestore()` for the `reports` collection
- [x] Create `frontend/report.html` — Reports page with separate "Class Schedule Reports" and "Exam Schedule Reports" cards
- [x] Create `frontend/report.css` — Reuse the green/cream design of class/exam pages
- [x] Create `frontend/report.js` — Load reports from Firestore, group by A.Y. + Semester, "View PDF" re-opens print window with correct filename
- [x] Edit `frontend/class.js` — Export PDF handler now also saves each class schedule to Firestore `reports` (filename: `A.Y. 2026-2027 1st Semester`)
- [x] Edit `frontend/exam.js` — Export PDF handler now also saves each exam schedule to Firestore `reports` (filename: `A.Y. 2026-2027 1st Semester Preliminary`)

## PDF Naming
- Class Schedule PDF: `A.Y. {academicYear} {semester}`
- Exam Schedule PDF: `A.Y. {academicYear} {semester} {examType}`

## Verify
- [ ] Open `report.html` in the browser
- [ ] Export a class schedule from class.html, then confirm it appears under Class Schedule Reports
- [ ] Export an exam schedule from exam.html, then confirm it appears under Exam Schedule Reports
- [ ] Click "View PDF" to re-open the stored printable report

