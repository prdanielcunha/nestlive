import { LocalRecoveryView } from './LocalRecoveryView';
import { useLiveNode } from './useLiveNode';

export function LocalNodeApp() {
  const controller = useLiveNode();
  return <LocalRecoveryView controller={controller} />;
}
