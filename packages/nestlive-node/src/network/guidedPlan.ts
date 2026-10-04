import type { NetworkInterface } from '@millionsnest/nestlive-domain';
import {
  detectSubnetConflicts,
  interfaceCanReachTargetBySubnet
} from './interfaces';

export type GuidedNetworkSeverity = 'ok' | 'attention' | 'blocked';

export interface GuidedNetworkCheck {
  id: string;
  label: string;
  severity: GuidedNetworkSeverity;
  detail: string;
  action?: string;
}

export interface GuidedNetworkPlan {
  cloudInterfaceId?: string;
  audioInterfaceId?: string;
  checks: GuidedNetworkCheck[];
  readyForReadOnlyProbe: boolean;
}

function chooseCloudInterface(
  interfaces: NetworkInterface[]
): NetworkInterface | undefined {
  return interfaces
    .filter(item => item.status === 'online' && item.gateway.length > 0)
    .sort((a, b) => (a.metric ?? 9999) - (b.metric ?? 9999))[0];
}

function chooseAudioInterface(
  interfaces: NetworkInterface[],
  targetAddress: string
): NetworkInterface | undefined {
  return interfaces
    .filter(item => item.status === 'online')
    .filter(item => interfaceCanReachTargetBySubnet(item, targetAddress))
    .sort((a, b) => {
      const aDedicated = a.gateway.length === 0 ? 0 : 1;
      const bDedicated = b.gateway.length === 0 ? 0 : 1;
      return aDedicated - bDedicated || (a.metric ?? 9999) - (b.metric ?? 9999);
    })[0];
}

export function buildGuidedNetworkPlan(
  interfaces: NetworkInterface[],
  targetAddress: string
): GuidedNetworkPlan {
  const checks: GuidedNetworkCheck[] = [];
  const cloud = chooseCloudInterface(interfaces);
  const audio = chooseAudioInterface(interfaces, targetAddress);
  const conflicts = detectSubnetConflicts(interfaces);

  checks.push(
    cloud
      ? {
          id: 'cloud',
          label: 'Internet',
          severity: 'ok',
          detail: `${cloud.humanName} possui gateway e será mantida como interface de nuvem.`
        }
      : {
          id: 'cloud',
          label: 'Internet',
          severity: 'attention',
          detail: 'Nenhuma interface com gateway foi identificada.',
          action: 'Verifique o cabo Ethernet ou a conexão principal.'
        }
  );

  checks.push(
    audio
      ? {
          id: 'audio',
          label: 'Rede de áudio',
          severity: 'ok',
          detail: `${audio.humanName} alcança a subnet de ${targetAddress}.`
        }
      : {
          id: 'audio',
          label: 'Rede de áudio',
          severity: 'blocked',
          detail: `Nenhuma interface está na mesma subnet de ${targetAddress}.`,
          action: 'Conecte o Wi‑Fi USB ao roteador da mesa e teste novamente.'
        }
  );

  if (cloud && audio && cloud.id === audio.id) {
    checks.push({
      id: 'isolation',
      label: 'Isolamento',
      severity: 'attention',
      detail: 'Internet e mesa estão usando a mesma interface.',
      action:
        'O caminho recomendado usa Ethernet para internet e Wi‑Fi USB dedicado para a mesa.'
    });
  } else if (cloud && audio) {
    checks.push({
      id: 'isolation',
      label: 'Isolamento',
      severity: 'ok',
      detail: 'Nuvem e mesa usam interfaces diferentes; nenhuma ponte é necessária.'
    });
  }

  if (conflicts.length > 0) {
    checks.push({
      id: 'subnet-conflict',
      label: 'Conflito de sub-rede',
      severity: 'attention',
      detail: `${conflicts.length} sobreposição(ões) de subnet detectada(s).`,
      action: 'Revise a faixa IP do roteador da mesa em Avançado.'
    });
  }

  return {
    cloudInterfaceId: cloud?.id,
    audioInterfaceId: audio?.id,
    checks,
    readyForReadOnlyProbe: Boolean(audio) && !checks.some(
      check => check.severity === 'blocked'
    )
  };
}
