import { auth, provider } from '../firebase';
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User as FirebaseUser
} from 'firebase/auth';
import { useAuthStore } from '../store/auth-store';
import { queryClient } from './client';

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080/api";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const mapFirebaseUserToAppUser = async (firebaseUser: FirebaseUser | null) => {
  if (!firebaseUser) return null;
  try {
    const token = await firebaseUser.getIdToken(true);
    useAuthStore.getState().setToken(token);

    let backendUser = null;
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts && !backendUser) {
      attempts++;
      const res = await fetch(`${API_URL}/users/firebase/${firebaseUser.uid}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
      });

      if (res.ok) {
        backendUser = await res.json();
        console.log(`Fetched backend user on attempt ${attempts}:`, backendUser);
      } else if (res.status === 404) {
        console.warn(`User not found in MongoDB, creating...`);
        const token2 = await firebaseUser.getIdToken(true);
        const newUser = {
          firebaseUID: firebaseUser.uid,
          firstName: firebaseUser.displayName?.split(' ')[0] || '',
          lastName: firebaseUser.displayName?.split(' ').slice(1).join(' ') || 'User',
          email: firebaseUser.email || '',
          avatar: firebaseUser.photoURL || null,
          role: '',
          phoneNumber: null,
          bio: null,
          institution: null,
          designation: null,
          address: null,
          emergencyContact: null,
          dateOfBirth: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const createRes = await fetch(`${API_URL}/users/firebase/${firebaseUser.uid}/profile`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token2}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(newUser),
        });

        if (createRes.ok) {
          backendUser = await createRes.json();
          console.log('Created backend user:', backendUser);
        } else {
          const errorText = await createRes.text();
          console.error('Failed to create backend user:', errorText);
          throw new Error(`Failed to create user: ${errorText}`);
        }
        break;
      } else {
        const errorText = await res.text();
        console.error('Failed to fetch backend user:', errorText);
        throw new Error(`Failed to fetch user: ${errorText}`);
      }
    }

    const mappedUser = {
      uid: firebaseUser.uid,
      email: firebaseUser.email || backendUser?.email || '',
      name: firebaseUser.displayName ||
        (backendUser ? `${backendUser.firstName} ${backendUser.lastName}`.trim() : ''),
      role: backendUser?.role || null,
      avatar: firebaseUser.photoURL || backendUser?.avatar || '',
      userId: backendUser?._id,
      firstName: backendUser?.firstName || firebaseUser.displayName?.split(' ')[0] || '',
      lastName: backendUser?.lastName || firebaseUser.displayName?.split(' ').slice(1).join(' ') || '',
      dateOfBirth: backendUser?.dateOfBirth || '',
      address: backendUser?.address || '',
      emergencyContact: backendUser?.emergencyContact || '',
      phoneNumber: backendUser?.phoneNumber || '',
      institution: backendUser?.institution || '',
      designation: backendUser?.designation || '',
      bio: backendUser?.bio || '',
      isVerified: backendUser?.isVerified || false,
      createdAt: backendUser?.createdAt,
      updatedAt: backendUser?.updatedAt
    };

    console.log('Mapped user:', mappedUser);
    return mappedUser;
  } catch (error) {
    console.error('Error mapping Firebase user:', error);
    return null;
  }
};

export const loginWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const user = await mapFirebaseUserToAppUser(result.user);
    if (user) {
      useAuthStore.getState().setUser(user);
      console.log('Google login successful:', user);
    }
    return result;
  } catch (error) {
    console.error('Google login error:', error);
    throw error;
  }
};

export const loginWithEmail = async (email: string, password: string) => {
  try {
    const result = await signInWithEmailAndPassword(auth, email, password);
    const user = await mapFirebaseUserToAppUser(result.user);
    if (user) {
      useAuthStore.getState().setUser(user);
      console.log('Email login successful:', user);
    }
    return result;
  } catch (error) {
    console.error('Email login error:', error);
    throw error;
  }
};

export const initAuth = () => {
  const { setUser, clearUser } = useAuthStore.getState();
  return onAuthStateChanged(auth, async (firebaseUser: FirebaseUser | null) => {
    if (firebaseUser) {
      try {
        const user = await mapFirebaseUserToAppUser(firebaseUser);
        if (user) {
          console.log('User authenticated and stored:', user);
          localStorage.setItem('isAuth', 'true');
          setUser(user);
        } else {
          console.error('Failed to map Firebase user to app user');
          clearUser();
        }
      } catch (error) {
        console.error('Error during auth state change:', error);
        clearUser();
      }
    } else {
      console.log('User signed out');
      clearUser();
    }
  });
};

export function logout() {
  try {
    localStorage.removeItem('isAuth');
    localStorage.removeItem('firebase-auth-token');
    firebaseSignOut(auth).catch(err => console.error('Firebase logout error:', err));
    useAuthStore.getState().clearUser();
    queryClient.clear();
    console.log('User logged out successfully');
  } catch (error) {
    console.error('Logout error:', error);
  }
}

export function checkAuth() {
  const token = localStorage.getItem('firebase-auth-token');
  const firebaseUser = auth.currentUser;
  const isAuth = localStorage.getItem('isAuth') === 'true';
  return !!token && !!firebaseUser && isAuth;
}

export async function getCurrentUserProfile() {
  const user = useAuthStore.getState().user;
  if (!user || !user.uid) return null;

  try {
    const token = await auth.currentUser?.getIdToken(true);
    if (!token) return null;

    const res = await fetch(`${API_URL}/users/firebase/${user.uid}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
    });

    if (res.ok) {
      return await res.json();
    } else {
      console.error('Failed to fetch user profile');
      return null;
    }
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return null;
  }
}

export async function updateUserProfile(profileData: {
  firstName?: string;
  lastName?: string;
  avatar?: string;
  role?: string;
}) {
  const user = useAuthStore.getState().user;
  if (!user) throw new Error('No authenticated user');

  try {
    const token = await auth.currentUser?.getIdToken(true);
    if (!token) throw new Error('No authentication token');

    const res = await fetch(`${API_URL}/users/firebase/${user.uid}/profile`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...profileData,
        updatedAt: new Date().toISOString()
      }),
    });

    if (res.ok) {
      const updatedUser = await res.json();
      const mappedUser = await mapFirebaseUserToAppUser(auth.currentUser);
      if (mappedUser) {
        useAuthStore.getState().setUser(mappedUser);
      }
      return updatedUser;
    } else {
      const errorText = await res.text();
      throw new Error(`Failed to update profile: ${errorText}`);
    }
  } catch (error) {
    console.error('Error updating user profile:', error);
    throw error;
  }
}

export { useLogin, useUserByFirebaseUID } from './hooks';