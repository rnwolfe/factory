import { create } from "zustand";

const STORAGE_KEY = "factory.token";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

interface AuthState {
  token: string | null;
  setToken: (t: string) => void;
  clear: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  token: readStored(),
  setToken: (t) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // private mode etc.
    }
    set({ token: t });
  },
  clear: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    set({ token: null });
  },
}));

export function getToken(): string | null {
  return useAuth.getState().token;
}
