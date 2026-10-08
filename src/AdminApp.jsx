    const activeTeamId = getActiveTeamIds(myProfile)[0] ?? null;
    const myMatches = (!isManager && myProfile) ? matches.filter(m => !m.isBye && m.homeTeam && m.awayTeam && (
      activeTeamId === m.homeTeam.id || activeTeamId === m.awayTeam.id
      || (myProfile.player_num && (m.homeRoster.some(p=>p.num===myProfile.player_num) || m.awayRoster.some(p=>p.num===myProfile.player_num)))
    )) : [];