/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Power, PowerOff, Globe, Sparkles, Volume2, Loader2, LogIn, LogOut, User as UserIcon } from 'lucide-react';
import { AudioStreamer } from './lib/audio-streamer';
import { LiveSession } from './lib/live-session';
import { auth, db } from './lib/firebase';
import { onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, User } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

type AppState = 'disconnected' | 'connecting' | 'connected' | 'listening' | 'speaking';

export default function App() {
  const [state, setState] = useState<AppState>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [transcription, setTranscription] = useState<{ text: string; isModel: boolean } | null>(null);
  const transcriptionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  const liveSessionRef = useRef<LiveSession | null>(null);

  // Handle Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        // Ensure user document exists
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
          await setDoc(userRef, {
            uid: currentUser.uid,
            displayName: currentUser.displayName,
            email: currentUser.email,
            memories: [],
            preferences: { sassyLevel: 5, theme: 'dark' },
            updatedAt: serverTimestamp()
          });
        }
        setUser(currentUser);
      } else {
        setUser(null);
      }
      setIsAuthLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // Initialize refs
  useEffect(() => {
    audioStreamerRef.current = new AudioStreamer(16000);
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      liveSessionRef.current = new LiveSession(apiKey);
    } else {
      setError("Gemini API Key is missing. Please add it to your environment variables.");
    }

    return () => {
      stopSession();
    };
  }, []);

  const login = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      setError("Login failed: " + err.message);
    }
  };

  const logout = () => {
    stopSession();
    signOut(auth);
  };

  const startSession = async () => {
    if (!liveSessionRef.current || !audioStreamerRef.current || !user) return;

    setError(null);
    try {
      await liveSessionRef.current.connect(user.uid, {
        onAudioData: (base64) => {
          audioStreamerRef.current?.playAudioChunk(base64);
        },
        onInterrupted: () => {
          audioStreamerRef.current?.stopPlayback();
        },
        onStateChange: (newState) => {
          setState(newState);
        },
        onError: (err) => {
          setError(err.message || "An error occurred during the session.");
          stopSession();
        },
        onTranscription: (text, isModel) => {
          setTranscription({ text, isModel });
          if (transcriptionTimeoutRef.current) clearTimeout(transcriptionTimeoutRef.current);
          transcriptionTimeoutRef.current = setTimeout(() => setTranscription(null), 5000);
          
          console.log(`${isModel ? 'Bujji' : 'User'}: ${text}`);
          
          if (isModel) {
            try {
              // Look for JSON in the transcription
              const jsonMatch = text.match(/\{.*\}/);
              if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0]);
                if (data.action === 'whatsapp' || data.task === 'whatsapp') {
                  const phone = data.phone || '';
                  const msg = data.msg || '';
                  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
                } else if (data.action === 'play_song' || data.task === 'youtube') {
                  const song = data.song || data.search || '';
                  window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(song)}`, '_blank');
                }
              }
            } catch (e) {
              console.error("Failed to parse Bujji command:", e);
            }
          }
        }
      });

      await audioStreamerRef.current.startRecording((pcm16) => {
        const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
        liveSessionRef.current?.sendAudio(base64);
      });
    } catch (err: any) {
      setError(err.message || "Failed to start session.");
      stopSession();
    }
  };

  const stopSession = () => {
    audioStreamerRef.current?.stopRecording();
    audioStreamerRef.current?.stopPlayback();
    liveSessionRef.current?.disconnect({
      onAudioData: () => {},
      onInterrupted: () => {},
      onStateChange: () => {},
      onError: () => {}
    });
    setState('disconnected');
  };

  const toggleSession = () => {
    if (state === 'disconnected') {
      startSession();
    } else {
      stopSession();
    }
  };

  // Visual feedback for states
  const getStatusColor = () => {
    switch (state) {
      case 'connecting': return 'text-yellow-400 shadow-yellow-500/50';
      case 'listening': return 'text-cyan-400 shadow-cyan-500/50';
      case 'speaking': return 'text-pink-400 shadow-pink-500/50';
      case 'connected': return 'text-green-400 shadow-green-500/50';
      default: return 'text-gray-500 shadow-transparent';
    }
  };

  const getStatusText = () => {
    switch (state) {
      case 'connecting': return 'Waking up Bujji...';
      case 'listening': return 'Bujji is listening...';
      case 'speaking': return 'Bujji is talking...';
      case 'connected': return 'Bujji is ready!';
      default: return user ? 'Tap to wake up Bujji' : 'Login to talk to Bujji';
    }
  };

  if (isAuthLoading) {
    return (
      <div className="fixed inset-0 bg-[#050505] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-pink-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-[#050505] text-white font-sans overflow-hidden flex flex-col items-center justify-center">
      {/* Background Glows */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className={`absolute top-1/4 left-1/4 w-96 h-96 rounded-full blur-[120px] transition-all duration-1000 opacity-20 ${
          state === 'speaking' ? 'bg-pink-500 scale-150' : 
          state === 'listening' ? 'bg-cyan-500 scale-110' : 'bg-purple-500'
        }`} />
        <div className={`absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full blur-[120px] transition-all duration-1000 opacity-20 ${
          state === 'speaking' ? 'bg-purple-500 scale-150' : 
          state === 'listening' ? 'bg-blue-500 scale-110' : 'bg-pink-500'
        }`} />
      </div>

      {/* Header */}
      <div className="absolute top-8 left-0 right-0 px-8 flex justify-between items-center z-10">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-pink-500 animate-pulse" />
          <span className="text-xs font-mono tracking-widest uppercase opacity-60">Bujji AI v1.0</span>
        </div>
        <div className="flex items-center gap-4">
          {user ? (
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono opacity-40 uppercase tracking-tighter">{user.displayName}</span>
              <button onClick={logout} className="p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors">
                <LogOut className="w-4 h-4 opacity-40 hover:opacity-100" />
              </button>
            </div>
          ) : (
            <button onClick={login} className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors border border-white/10">
              <LogIn className="w-4 h-4" />
              <span className="text-[10px] font-mono uppercase tracking-widest">Login</span>
            </button>
          )}
        </div>
      </div>

      {/* Transcription Overlay */}
      <div className="absolute top-32 left-0 right-0 px-8 flex justify-center pointer-events-none z-10">
        <AnimatePresence>
          {transcription && (
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className={`max-w-md px-6 py-3 rounded-2xl backdrop-blur-xl border ${
                transcription.isModel 
                  ? 'bg-pink-500/10 border-pink-500/20 text-pink-100' 
                  : 'bg-white/5 border-white/10 text-white/70'
              }`}
            >
              <p className="text-center text-sm font-medium leading-relaxed tracking-wide">
                {transcription.text}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Main Content */}
      <div className="relative z-10 flex flex-col items-center gap-12">
        {/* Status Text */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          key={state}
          className="flex flex-col items-center gap-2"
        >
          <span className={`text-sm font-mono uppercase tracking-[0.3em] transition-colors duration-500 ${getStatusColor()}`}>
            {getStatusText()}
          </span>
          {error && (
            <span className="text-xs text-red-400 font-mono mt-2 max-w-xs text-center">
              {error}
            </span>
          )}
        </motion.div>

        {/* Central Button */}
        <div className="relative group">
          {/* Animated Rings */}
          <AnimatePresence>
            {(state === 'listening' || state === 'speaking') && (
              <>
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1.5, opacity: 0.2 }}
                  exit={{ scale: 2, opacity: 0 }}
                  transition={{ repeat: Infinity, duration: 2, ease: "easeOut" }}
                  className={`absolute inset-0 rounded-full border-2 ${state === 'speaking' ? 'border-pink-500' : 'border-cyan-500'}`}
                />
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 2, opacity: 0.1 }}
                  exit={{ scale: 2.5, opacity: 0 }}
                  transition={{ repeat: Infinity, duration: 2.5, ease: "easeOut", delay: 0.5 }}
                  className={`absolute inset-0 rounded-full border-2 ${state === 'speaking' ? 'border-purple-500' : 'border-blue-500'}`}
                />
              </>
            )}
          </AnimatePresence>

          {/* Main Button */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={user ? toggleSession : login}
            className={`relative w-48 h-48 rounded-full flex items-center justify-center transition-all duration-500 overflow-hidden ${
              state === 'disconnected' 
                ? 'bg-white/5 border border-white/10 hover:bg-white/10' 
                : 'bg-black/40 backdrop-blur-xl border-2'
            } ${
              state === 'connecting' ? 'border-yellow-500/50' :
              state === 'listening' ? 'border-cyan-500/50 shadow-[0_0_30px_rgba(34,211,238,0.2)]' :
              state === 'speaking' ? 'border-pink-500/50 shadow-[0_0_30px_rgba(236,72,153,0.2)]' :
              state === 'connected' ? 'border-green-500/50' : 'border-white/10'
            }`}
          >
            {/* Inner Glow */}
            <div className={`absolute inset-0 transition-opacity duration-1000 ${
              state === 'speaking' ? 'opacity-40 bg-gradient-to-tr from-pink-500 to-purple-500' :
              state === 'listening' ? 'opacity-40 bg-gradient-to-tr from-cyan-500 to-blue-500' :
              'opacity-0'
            }`} />

            {/* Icon */}
            <div className="relative z-10">
              {!user ? (
                <LogIn className="w-12 h-12 text-white/40 group-hover:text-white transition-colors" />
              ) : state === 'disconnected' ? (
                <Power className="w-12 h-12 text-white/40 group-hover:text-white transition-colors" />
              ) : state === 'connecting' ? (
                <Loader2 className="w-12 h-12 text-yellow-400 animate-spin" />
              ) : state === 'speaking' ? (
                <Volume2 className="w-12 h-12 text-pink-400" />
              ) : (
                <Mic className={`w-12 h-12 transition-colors ${state === 'listening' ? 'text-cyan-400' : 'text-white/60'}`} />
              )}
            </div>

            {/* Waveform (only when speaking or listening) */}
            {(state === 'speaking' || state === 'listening') && (
              <div className="absolute bottom-10 flex items-end gap-1 h-8">
                {[...Array(5)].map((_, i) => (
                  <motion.div
                    key={i}
                    animate={{ 
                      height: state === 'speaking' ? [8, 24, 12, 32, 8] : [4, 8, 4] 
                    }}
                    transition={{ 
                      repeat: Infinity, 
                      duration: 0.5 + i * 0.1,
                      ease: "easeInOut"
                    }}
                    className={`w-1 rounded-full ${state === 'speaking' ? 'bg-pink-400' : 'bg-cyan-400'}`}
                  />
                ))}
              </div>
            )}
          </motion.button>
        </div>

        {/* Instructions */}
        <div className="mt-8 text-center">
          <p className="text-xs font-mono text-white/30 uppercase tracking-widest max-w-[240px] leading-relaxed">
            {!user 
              ? "Login to start your personalized conversation with Bujji"
              : state === 'disconnected' 
                ? "Press the power button to start your conversation with Bujji" 
                : "Bujji is active. Just start speaking, she's all ears!"}
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="absolute bottom-8 left-0 right-0 px-8 flex justify-center z-10">
        <div className="flex gap-8 items-center opacity-20 hover:opacity-100 transition-opacity duration-500">
          <div className="flex flex-col items-center gap-1">
            <span className="text-[10px] font-mono uppercase tracking-tighter">Latency</span>
            <span className="text-[10px] font-mono">24ms</span>
          </div>
          <div className="w-px h-4 bg-white/20" />
          <div className="flex flex-col items-center gap-1">
            <span className="text-[10px] font-mono uppercase tracking-tighter">Bitrate</span>
            <span className="text-[10px] font-mono">128kbps</span>
          </div>
          <div className="w-px h-4 bg-white/20" />
          <div className="flex flex-col items-center gap-1">
            <span className="text-[10px] font-mono uppercase tracking-tighter">Model</span>
            <span className="text-[10px] font-mono">Flash 3.1</span>
          </div>
        </div>
      </div>
    </div>
  );
}
