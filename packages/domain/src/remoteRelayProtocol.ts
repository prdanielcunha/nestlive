import type {
  AudioCommandEnvelope,
  AudioCommandExecution
} from './audioCommands';
import type {
  AudioCapability,
  AudioChannel,
  AudioConsoleState,
  MeterFrame
} from './audio';
import type {
  RemoteMeterProfile,
  RemoteMixGrant
} from './remoteMix';

export interface RemoteRelayScope {
  nodeId: string;
  organizationId: string;
  venueId: string;
  liveSystemId: string;
}

export interface RemoteRelayIdentity {
  uid: string;
  email?: string;
}

export type RemoteRelayClientMessage =
  | {
      type: 'client.hello';
      idToken: string;
      grantToken: string;
      scope: RemoteRelayScope;
    }
  | {
      type: 'client.meter-profile';
      profile: RemoteMeterProfile;
      visible: boolean;
    }
  | {
      type: 'client.snapshot';
      requestId: string;
    }
  | {
      type: 'client.command';
      requestId: string;
      envelope: AudioCommandEnvelope;
    }
  | {
      type: 'client.ping';
      sentAt: number;
    };

export type RemoteRelayNodeMessage =
  | {
      type: 'node.hello';
      ticket: string;
    }
  | {
      type: 'node.client-auth-result';
      requestId: string;
      accepted: boolean;
      grant?: RemoteMixGrant;
      reason?: string;
    }
  | {
      type: 'node.snapshot-result';
      clientId: string;
      requestId: string;
      snapshot?: {
        providerInstanceId: string;
        capabilities: AudioCapability[];
        state: AudioConsoleState;
        channels: AudioChannel[];
      };
      error?: string;
    }
  | {
      type: 'node.command-result';
      clientId: string;
      requestId: string;
      execution?: AudioCommandExecution;
      error?: string;
    }
  | {
      type: 'node.meter';
      clientId: string;
      frame: MeterFrame;
    }
  | {
      type: 'node.pong';
      clientId: string;
      sentAt: number;
      receivedAt: number;
    };

export type RemoteRelayServerMessage =
  | {
      type: 'relay.ready';
      connectionId: string;
    }
  | {
      type: 'relay.node-online';
      scope: RemoteRelayScope;
    }
  | {
      type: 'relay.client-auth';
      requestId: string;
      clientId: string;
      identity: RemoteRelayIdentity;
      grantToken: string;
      scope: RemoteRelayScope;
    }
  | {
      type: 'relay.client-detached';
      clientId: string;
    }
  | {
      type: 'relay.meter-profile';
      clientId: string;
      profile: RemoteMeterProfile;
      visible: boolean;
    }
  | {
      type: 'relay.snapshot';
      clientId: string;
      requestId: string;
    }
  | {
      type: 'relay.command';
      clientId: string;
      requestId: string;
      envelope: AudioCommandEnvelope;
    }
  | {
      type: 'relay.ping';
      clientId: string;
      sentAt: number;
    }
  | {
      type: 'relay.authenticated';
      clientId: string;
      grant: RemoteMixGrant;
    }
  | {
      type: 'relay.denied';
      reason: string;
    }
  | {
      type: 'relay.snapshot-result';
      requestId: string;
      snapshot?: {
        providerInstanceId: string;
        capabilities: AudioCapability[];
        state: AudioConsoleState;
        channels: AudioChannel[];
      };
      error?: string;
    }
  | {
      type: 'relay.command-result';
      requestId: string;
      execution?: AudioCommandExecution;
      error?: string;
    }
  | {
      type: 'relay.meter';
      frame: MeterFrame;
    }
  | {
      type: 'relay.pong';
      sentAt: number;
      receivedAt: number;
    }
  | {
      type: 'relay.error';
      code: string;
      message?: string;
    };
