// Centralized API configuration for SLSU Lucena Scheduling System frontend

export const isLocalHost = Boolean(
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "[::1]" ||
    window.location.protocol === "file:" ||
    window.location.hostname.startsWith("192.168.") ||
    window.location.hostname.startsWith("10.") ||
    !window.location.hostname
);

export const API_BASE_URL = isLocalHost
    ? "http://localhost:3000"
    : "https://slsulucena-scheduling-system.onrender.com";

export default API_BASE_URL;

