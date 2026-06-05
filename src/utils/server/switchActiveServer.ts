import type { ServerProfile } from '../../store/authStoreTypes';
import { scheduleInstantMixProbeForServer } from '../../api/subsonic';
import {
  coverTrafficBeginServerSwitch,
  coverTrafficEndServerSwitch,
} from '../../cover/coverTraffic';
import { useAuthStore } from '../../store/authStore';
import { useOrbitStore } from '../../store/orbitStore';
import { endOrbitSession, leaveOrbitSession } from '../orbit';
import { ensureConnectUrlResolved } from './serverEndpoint';
import { recomputeClusterRepresentative } from '../serverCluster/representative';

async function teardownOrbitIfNeeded(): Promise<void> {
  const role = useOrbitStore.getState().role;
  if (role !== 'host' && role !== 'guest') return;
  const teardown = role === 'host' ? endOrbitSession() : leaveOrbitSession();
  await Promise.race([
    teardown.catch(() => {}),
    new Promise<void>(r => setTimeout(r, 1500)),
  ]);
  useOrbitStore.getState().reset();
}

export async function switchActiveCluster(clusterId: string): Promise<boolean> {
  coverTrafficBeginServerSwitch();
  try {
    const auth = useAuthStore.getState();
    const cluster = auth.clusters.find(c => c.id === clusterId);
    if (!cluster) return false;

    await teardownOrbitIfNeeded();
    auth.setActiveCluster(clusterId);
    await recomputeClusterRepresentative(clusterId);

    const rep = useAuthStore.getState().getActiveServer();
    if (!rep) return false;

    const probe = await ensureConnectUrlResolved(rep);
    if (!probe.ok) return false;

    const identity = {
      type: probe.ping.type,
      serverVersion: probe.ping.serverVersion,
      openSubsonic: probe.ping.openSubsonic,
    };
    auth.setSubsonicServerIdentity(rep.id, identity);
    scheduleInstantMixProbeForServer(rep.id, probe.baseUrl, rep.username, rep.password, identity);
    auth.setLoggedIn(true);
    return true;
  } catch {
    return false;
  } finally {
    coverTrafficEndServerSwitch();
  }
}

export async function switchActiveServer(server: ServerProfile): Promise<boolean> {
  coverTrafficBeginServerSwitch();
  try {
    const probe = await ensureConnectUrlResolved(server);
    if (!probe.ok) return false;

    await teardownOrbitIfNeeded();

    const identity = {
      type: probe.ping.type,
      serverVersion: probe.ping.serverVersion,
      openSubsonic: probe.ping.openSubsonic,
    };
    const auth = useAuthStore.getState();
    auth.setSubsonicServerIdentity(server.id, identity);
    scheduleInstantMixProbeForServer(server.id, probe.baseUrl, server.username, server.password, identity);
    auth.setActiveServer(server.id);
    auth.setLoggedIn(true);
    return true;
  } catch {
    return false;
  } finally {
    coverTrafficEndServerSwitch();
  }
}
