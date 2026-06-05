import {
  libraryClusterPlayerStatsDayDetail,
  libraryClusterPlayerStatsHeatmap,
  libraryClusterPlayerStatsMostPlayed,
  libraryClusterPlayerStatsRecentDays,
  libraryClusterPlayerStatsYearSummary,
  libraryGetPlayerStatsDayDetail,
  libraryGetPlayerStatsHeatmap,
  libraryGetPlayerStatsRecentDays,
  libraryGetPlayerStatsYearBounds,
  libraryGetPlayerStatsYearSummary,
  type PlaySessionDayDetail,
  type PlaySessionHeatmapDay,
  type PlaySessionMostPlayed,
  type PlaySessionRecentDay,
  type PlaySessionYearSummary,
} from '../../api/library';
import { resolveClusterBrowseMembers } from './clusterBrowse';

export async function loadPlayerStatsYearSummary(year: number): Promise<PlaySessionYearSummary> {
  const members = await resolveClusterBrowseMembers();
  if (members) {
    return libraryClusterPlayerStatsYearSummary({ serversOrdered: members, year });
  }
  return libraryGetPlayerStatsYearSummary(year);
}

export async function loadPlayerStatsHeatmap(year: number): Promise<PlaySessionHeatmapDay[]> {
  const members = await resolveClusterBrowseMembers();
  if (members) {
    return libraryClusterPlayerStatsHeatmap({ serversOrdered: members, year });
  }
  return libraryGetPlayerStatsHeatmap(year);
}

export async function loadPlayerStatsYearBounds() {
  return libraryGetPlayerStatsYearBounds();
}

export async function loadPlayerStatsDayDetail(dateIso: string): Promise<PlaySessionDayDetail> {
  const members = await resolveClusterBrowseMembers();
  if (members) {
    return libraryClusterPlayerStatsDayDetail({ serversOrdered: members, dateIso });
  }
  return libraryGetPlayerStatsDayDetail(dateIso);
}

export async function loadPlayerStatsRecentDays(limit = 30): Promise<PlaySessionRecentDay[]> {
  const members = await resolveClusterBrowseMembers();
  if (members) {
    return libraryClusterPlayerStatsRecentDays({ serversOrdered: members, limit });
  }
  return libraryGetPlayerStatsRecentDays(limit);
}

export async function loadPlayerStatsMostPlayed(limit = 50): Promise<PlaySessionMostPlayed[]> {
  const members = await resolveClusterBrowseMembers();
  if (members) {
    return libraryClusterPlayerStatsMostPlayed({ serversOrdered: members, limit });
  }
  return [];
}
