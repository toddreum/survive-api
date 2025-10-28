import { io } from "socket.io-client";

// Change to your backend endpoint for production!
export const socket = io("http://localhost:4000"); 
