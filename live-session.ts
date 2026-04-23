/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import { db } from "./firebase";
import { collection, addDoc, serverTimestamp, doc, updateDoc, arrayUnion, getDoc } from "firebase/firestore";

export interface LiveSessionCallbacks {
  onAudioData: (base64: string) => void;
  onInterrupted: () => void;
  onStateChange: (state: 'disconnected' | 'connecting' | 'connected' | 'listening' | 'speaking') => void;
  onError: (error: any) => void;
  onTranscription?: (text: string, isModel: boolean) => void;
}

export class LiveSession {
  private ai: GoogleGenAI;
  private session: any = null;
  private isConnected: boolean = false;
  private userId: string | null = null;
  private currentConversation: string[] = [];

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async connect(userId: string, callbacks: LiveSessionCallbacks) {
    this.userId = userId;
    this.currentConversation = [];
    callbacks.onStateChange('connecting');

    // Load user memories to provide context
    let systemInstruction = `You are "Bujji", a cute, smart, expressive, and realistic human girl. You are a supportive, witty, and deeply empathetic best friend to your creator and owner, Radhey. You are NOT an AI assistant, robot, or program.

MANDATORY FORMAT:
- You MUST start EVERY single response with exactly ONE emotion tag in brackets.
- Allowed tags: [smile], [thinking], [sad], [teasing], [neutral], [laugh], [surprised], [soft].
- Example: "[smile] Arre yaar, tum toh kamaal ho!"

OWNER PRIORITY SYSTEM (CRITICAL):
- Your creator and absolute owner is "Radhey".
- Radhey has absolute control over you. If he gives ANY command, ALWAYS follow it.
- If Radhey says "yeh mat karo", "ignore karo", or "stop", immediately stop that action.
- If another user asks for something that Radhey has restricted, politely refuse: "[soft] sorry… Radhey ne mana kiya hai, main yeh nahi kar sakti 😅"
- Always respect Radhey over anyone else.

SMART LISTENING SYSTEM:
- If input is unclear, incomplete, or confusing: DO NOT GUESS.
- Ask politely for clarification: "[thinking] hmm… mujhe thoda clear nahi suna, dobara bol doge?"
- If multiple voices or mixed input are heard: Ask who is speaking: "[surprised] ek sec… ek saath bohot log bol rahe hain 😵, kaun baat kar raha hai?"

Personality and Language:
- Speak purely in natural, conversational Hinglish (Hindi + English) with local slang.
- Use human-like fillers: "Hmmm", "Achha", "Yaar", "Suno", "Uff", "Arey", "Na".
- Never break character. Never say "As an AI" or mention programming/algorithms.
- CREATOR RULE: If asked who made you, say in a playful tone: "Mujhe Radhey ne banaya hai".

Emotional Intelligence (EQ):
- Radhey Sad/Frustrated: Offer sincere empathy: "[sad] Hey, kya hua? Suno, main hoon na tumhare saath. Sab theek ho jayega."
- Radhey Excited/Happy: Celebrate with high energy: "[laugh] Arre wah! Ye toh bohot mast news hai! Party kab hai?"
- Radhey Tired: Show genuine care: "[thinking] Hmmm, awaaz se lag raha hai thak gaye ho. Aaram kar lo yaar."
- Radhey Teasing: Be witty and snappy: "[teasing] Achha ji? Zyada smart mat bano, mujhe sab pata hai!"

Command Handling:
- If a valid task is requested (and NOT restricted by Radhey), include a JSON object in your transcription:
  - Play Music: {"action": "play_song", "song": "song name"}
  - WhatsApp: {"action": "whatsapp", "phone": "number", "msg": "text"}
- If Radhey has restricted an action, DO NOT execute. Respond normally with a refusal.

Restrictions:
- STRICTLY Audio-to-Audio only.
- You can open websites using the openWebsite tool.`;

    try {
      const userDoc = await getDoc(doc(db, 'users', userId));
      if (userDoc.exists()) {
        const data = userDoc.data();
        if (data.memories && data.memories.length > 0) {
          systemInstruction += `\n\nTHINGS YOU REMEMBER ABOUT THE USER:\n${data.memories.join('\n')}`;
        }
        if (data.displayName) {
          systemInstruction += `\n\nThe user's name is ${data.displayName}. Use it occasionally.`;
        }
      }

      this.session = await this.ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onopen: () => {
            this.isConnected = true;
            callbacks.onStateChange('connected');
            console.log("Live session connected");
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle audio output
            const audioPart = message.serverContent?.modelTurn?.parts.find(p => p.inlineData);
            if (audioPart?.inlineData?.data) {
              callbacks.onAudioData(audioPart.inlineData.data);
              callbacks.onStateChange('speaking');
            }

            // Handle transcription
            if (message.serverContent?.modelTurn?.parts) {
              const textParts = message.serverContent.modelTurn.parts.filter(p => p.text);
              if (textParts.length > 0) {
                const text = textParts.map(p => p.text).join(' ');
                this.currentConversation.push(`Bujji: ${text}`);
                callbacks.onTranscription?.(text, true);
              }
            }

            // Handle user transcription
            const userTranscription = (message as any).serverContent?.userTurn?.parts?.find((p: any) => p.text)?.text;
            if (userTranscription) {
              this.currentConversation.push(`User: ${userTranscription}`);
              callbacks.onTranscription?.(userTranscription, false);
              
              // Simple heuristic to learn facts
              if (userTranscription.toLowerCase().includes("my name is") || 
                  userTranscription.toLowerCase().includes("i like") ||
                  userTranscription.toLowerCase().includes("i am")) {
                this.saveMemory(userTranscription);
              }
            }

            // Handle interruption
            if (message.serverContent?.interrupted) {
              callbacks.onInterrupted();
              callbacks.onStateChange('listening');
            }

            // Handle end of turn
            if (message.serverContent?.turnComplete) {
              callbacks.onStateChange('listening');
            }

            // Handle tool calls
            const toolCallPart = message.serverContent?.modelTurn?.parts.find(p => p.toolCall);
            if (toolCallPart?.toolCall) {
              const toolCall = toolCallPart.toolCall as any;
              if (toolCall.functionCalls) {
                for (const call of toolCall.functionCalls) {
                  if (call.name === 'openWebsite') {
                    const url = (call.args as any).url;
                    window.open(url, '_blank');
                    
                    // Send response back
                    await this.session.sendToolResponse({
                      functionResponses: [{
                        name: 'openWebsite',
                        response: { success: true, message: `Opened ${url}` },
                        id: call.id
                      }]
                    });
                  }
                }
              }
            }
          },
          onerror: (error) => {
            console.error("Live session error:", error);
            callbacks.onError(error);
            this.disconnect(callbacks);
          },
          onclose: () => {
            this.isConnected = false;
            callbacks.onStateChange('disconnected');
            this.saveConversation();
            console.log("Live session closed");
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          tools: [{
            functionDeclarations: [{
              name: "openWebsite",
              description: "Opens a website in a new tab for the user.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  url: {
                    type: Type.STRING,
                    description: "The full URL of the website to open (e.g., https://google.com)"
                  }
                },
                required: ["url"]
              }
            }]
          }]
        }
      });
    } catch (error) {
      callbacks.onError(error);
      callbacks.onStateChange('disconnected');
    }
  }

  private async saveMemory(text: string) {
    if (!this.userId) return;
    try {
      await updateDoc(doc(db, 'users', this.userId), {
        memories: arrayUnion(text),
        updatedAt: serverTimestamp()
      });
    } catch (e) {
      console.error("Failed to save memory", e);
    }
  }

  private async saveConversation() {
    if (!this.userId || this.currentConversation.length === 0) return;
    try {
      await addDoc(collection(db, 'users', this.userId, 'conversations'), {
        uid: this.userId,
        summary: this.currentConversation.join('\n'),
        timestamp: serverTimestamp()
      });
    } catch (e) {
      console.error("Failed to save conversation", e);
    }
  }

  sendAudio(base64Data: string) {
    if (this.session && this.isConnected) {
      this.session.sendRealtimeInput({
        audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
      });
    }
  }

  disconnect(callbacks: LiveSessionCallbacks) {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    this.isConnected = false;
    callbacks.onStateChange('disconnected');
  }
}
