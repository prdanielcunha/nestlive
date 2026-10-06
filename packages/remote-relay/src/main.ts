import {
  FirebaseAdminIdentityVerifier,
  FirebaseScopeClaimAuthorizer,
  RelayTicketSigner,
  RemoteRelayServer
} from './index';

const port = Number(process.env.PORT || 8080);
const signingKey = process.env.NESTLIVE_RELAY_SIGNING_KEY?.trim();
if (!signingKey) {
  throw new Error('NESTLIVE_RELAY_SIGNING_KEY_required');
}

const server = new RemoteRelayServer({
  port,
  identityVerifier: new FirebaseAdminIdentityVerifier(),
  scopeAuthorizer: new FirebaseScopeClaimAuthorizer(
    process.env.NESTLIVE_SCOPE_CLAIM?.trim() || 'nestliveScopes'
  ),
  ticketSigner: new RelayTicketSigner(signingKey)
});

await server.start();

console.log(
  JSON.stringify({
    event: 'nestlive_remote_relay_ready',
    port
  })
);

const stop = async () => {
  await server.close().catch(() => undefined);
  process.exit(0);
};

process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
