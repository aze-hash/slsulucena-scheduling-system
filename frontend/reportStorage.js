import { db } from "../firebase.js";

import {
    collection,
    addDoc,
    setDoc,
    getDocs,
    deleteDoc,
    doc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const REPORTS_COLLECTION = "reports";

/**
 * Build a stable-ish document id for a report so that saving the same
 * category + academicYear + semester (+ examType) overwrites the previous
 * version. If you prefer a full history instead, simply leave the id blank so
 * addDoc generates a random one each time.
 */
export function reportDocId(report) {
    const parts = [
        report.category || "",
        report.title || "",
        report.academicYear || "",
        report.semester || "",
        report.examType || ""
    ].join("_");
    const raw = parts.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
    return raw || crypto.randomUUID();
}

/**
 * Save a report document to Firestore ("reports" collection).
 * @param {Object} report - { category, academicYear, semester, yearLevel, examType, title, filename, html }
 */
export async function saveReportToFirestore(report) {
    const docId = report.id || reportDocId(report);
    const docRef = doc(db, REPORTS_COLLECTION, docId);
    await setDoc(docRef, {
        category: report.category || "",
        academicYear: report.academicYear || "",
        semester: report.semester || "",
        yearLevel: report.yearLevel || "",
        examType: report.examType || "",
        title: report.title || "",
        filename: report.filename || "",
        html: report.html || "",
        createdAt: new Date(),
        updatedAt: new Date()
    }, { merge: true });
    return docId;
}

/**
 * Load all reports from Firestore.
 * @returns {Promise<Array>} Array of report objects.
 */
export async function loadReportsFromFirestore() {
    try {
        const snapshot = await getDocs(collection(db, REPORTS_COLLECTION));
        return snapshot.docs.map(document => {
            const data = document.data();
            return {
                id: document.id,
                category: data.category || "",
                academicYear: data.academicYear || "",
                semester: data.semester || "",
                yearLevel: data.yearLevel || "",
                examType: data.examType || "",
                title: data.title || "",
                filename: data.filename || "",
                html: data.html || "",
                createdAt: data.createdAt?.toDate?.()?.toISOString?.() || data.createdAt || new Date().toISOString()
            };
        });
    } catch (error) {
        console.error("Could not load reports from Firestore:", error);
        return [];
    }
}

export async function deleteReportFromFirestore(reportId) {
    if (!reportId) {
        throw new Error("A report id is required to delete a report.");
    }

    try {
        await deleteDoc(doc(db, REPORTS_COLLECTION, reportId));
    } catch (error) {
        console.error("Could not delete report from Firestore:", error);
        throw error;
    }
}

/**
 * Delete all reports in a specific category from Firestore ("reports" collection).
 * @param {string} category - "Class Schedule" or "Exam Schedule"
 * @returns {Promise<number>} Number of reports deleted.
 */
export async function deleteReportsByCategoryFromFirestore(category) {
    try {
        const snapshot = await getDocs(collection(db, REPORTS_COLLECTION));
        const toDelete = snapshot.docs.filter(docSnap => {
            const data = docSnap.data();
            if (category === "Exam Schedule") {
                return data.category === "Exam Schedule";
            } else {
                return data.category !== "Exam Schedule";
            }
        });

        const deletePromises = toDelete.map(docSnap =>
            deleteDoc(doc(db, REPORTS_COLLECTION, docSnap.id))
        );
        await Promise.all(deletePromises);
        return toDelete.length;
    } catch (error) {
        console.error(`Could not delete reports for category ${category}:`, error);
        throw error;
    }
}

/**
 * Delete all reports from Firestore ("reports" collection).
 * @returns {Promise<number>} Number of reports deleted.
 */
export async function deleteAllReportsFromFirestore() {
    try {
        const snapshot = await getDocs(collection(db, REPORTS_COLLECTION));
        const deletePromises = snapshot.docs.map(document =>
            deleteDoc(doc(db, REPORTS_COLLECTION, document.id))
        );
        await Promise.all(deletePromises);
        return snapshot.size;
    } catch (error) {
        console.error("Could not delete all reports from Firestore:", error);
        throw error;
    }
}

export async function deleteArchivedClassSchedulesFromFirestore() {
    try {
        const snapshot = await getDocs(collection(db, "classSchedules"));
        const archivedDocs = snapshot.docs.filter(d => d.data()?.status === "archived");
        const deletePromises = archivedDocs.map(d => deleteDoc(doc(db, "classSchedules", d.id)));
        await Promise.all(deletePromises);
        return archivedDocs.length;
    } catch (error) {
        console.error("Could not delete archived class schedules from Firestore:", error);
        throw error;
    }
}


