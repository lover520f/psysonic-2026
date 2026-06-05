import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ServerCluster } from '../utils/serverCluster/types';
import {
  formatExcludedMemberLabels,
  getClusterMergeDiagnostics,
  type ClusterMergeDiagnostics,
} from '../utils/serverCluster/clusterMergeStatus';

export default function ClusterMergeBanner({ cluster }: { cluster: ServerCluster }) {
  const { t } = useTranslation();
  const [diag, setDiag] = useState<ClusterMergeDiagnostics | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getClusterMergeDiagnostics(cluster).then(res => {
      if (!cancelled) setDiag(res);
    }).catch(() => {
      if (!cancelled) setDiag(null);
    });
    return () => { cancelled = true; };
  }, [cluster]);

  if (!diag || diag.mergeCount >= diag.totalCount) return null;
  return (
    <div className="connection-indicator-cluster-banner">
      {t('cluster.mergeBanner', {
        excluded: formatExcludedMemberLabels(diag.members),
      })}
    </div>
  );
}
