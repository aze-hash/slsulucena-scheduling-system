import { initializeApp }
from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";

import { getFirestore }
from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import { getAuth }
from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDPYU4M5hnIubQFsm9onxQboqQW01U-27o",
  authDomain: "slsulucena-scheduling-system.firebaseapp.com",
  projectId: "slsulucena-scheduling-system",
  storageBucket: "slsulucena-scheduling-system.firebasestorage.app",
  messagingSenderId: "536922398748",
  appId: "1:536922398748:web:c65f555951053709017fd9",
  measurementId: "G-9TDJ6RGP4Q"
};

const app = initializeApp(firebaseConfig);

const db = getFirestore(app);
const auth = getAuth(app);

export { db, auth };