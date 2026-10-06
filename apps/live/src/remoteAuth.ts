import { initializeApp, getApps } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithCustomToken,
  signInWithPopup,
  signOut,
  type User
} from 'firebase/auth';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ||
    'millionsnest.firebaseapp.com',
  projectId:
    import.meta.env.VITE_FIREBASE_PROJECT_ID || 'millionsnest',
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ||
    'millionsnest.appspot.com',
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export function remoteFirebaseConfigured(): boolean {
  return Boolean(
    config.apiKey &&
      config.apiKey !== 'undefined' &&
      config.apiKey !== 'your_api_key'
  );
}

function authInstance() {
  if (!remoteFirebaseConfigured()) {
    throw new Error('firebase_not_configured');
  }
  const app = getApps()[0] ?? initializeApp(config);
  return getAuth(app);
}

export function observeRemoteUser(
  listener: (user: User | null) => void
): () => void {
  return onAuthStateChanged(authInstance(), listener);
}

export async function remoteGoogleSignIn(): Promise<User> {
  const result = await signInWithPopup(
    authInstance(),
    new GoogleAuthProvider()
  );
  return result.user;
}

export async function remoteEmailSignIn(
  email: string,
  password: string
): Promise<User> {
  const result = await signInWithEmailAndPassword(
    authInstance(),
    email,
    password
  );
  return result.user;
}

export async function remoteCustomTokenSignIn(
  customToken: string
): Promise<User> {
  const result = await signInWithCustomToken(
    authInstance(),
    customToken
  );
  return result.user;
}

export async function remoteSignOut(): Promise<void> {
  await signOut(authInstance());
}

export type { User as RemoteFirebaseUser };
