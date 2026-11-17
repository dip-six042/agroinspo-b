// Live video for events (and, in Phase 3, consultations).
//
// VIDEO_PROVIDER selects the adapter:
//   dummy (default) – the browser shows a simulated stage; chat, Q&A, attendance and
//                     host controls are all real.
//   agora           – issues Agora RTC tokens. Needs AGORA_APP_ID, AGORA_APP_CERTIFICATE and
//                     the `agora-token` npm package (npm i agora-token), plus the Agora Web SDK
//                     (`agora-rtc-sdk-ng`) in the browser. See the TODO in joinToken().
//
// The rest of the app only uses createRoom() and joinToken(), so switching providers
// doesn't touch events, permissions or attendance code.

export function createVideoProvider(config = {}) {
  const provider = config.provider || process.env.VIDEO_PROVIDER || 'dummy';

  if (provider === 'agora') {
    const appId = config.appId || process.env.AGORA_APP_ID;
    const cert = config.appCertificate || process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !cert) throw new Error('AGORA_APP_ID and AGORA_APP_CERTIFICATE are required for VIDEO_PROVIDER=agora.');
    return {
      name: 'agora',
      createRoom: (eventId) => `ev_${eventId.replace(/-/g, '').slice(0, 24)}`,
      async joinToken({ roomId, userId, role, ttlSeconds = 4 * 3600 }) {
        // TODO(agora): after `npm i agora-token`:
        //   const { RtcTokenBuilder, RtcRole } = await import('agora-token');
        //   const token = RtcTokenBuilder.buildTokenWithUserAccount(appId, cert, roomId, userId,
        //     role === 'host' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER, ttlSeconds, ttlSeconds);
        //   return { provider: 'agora', appId, channel: roomId, uid: userId, token, role };
        throw new Error('Agora token generation is not installed yet. See server/video.js.');
      }
    };
  }

  return {
    name: 'dummy',
    createRoom: (eventId) => `ev_${eventId.replace(/-/g, '').slice(0, 24)}`,
    async joinToken({ roomId, userId, role }) {
      return { provider: 'dummy', channel: roomId, uid: userId, token: 'dummy', role };
    }
  };
}
