/**
 * FRENVI Assessor Admin Web Portal
 * Live Agora RTC Video Calling & Real-Time Competency Evaluation Desk
 */

// Global State
let socket = null;
let currentCandidate = null;
let agoraClient = null;
let localTracks = {
  audioTrack: null,
  videoTrack: null
};
let isMicMuted = false;
let isCamOff = false;
let timerInterval = null;
let secondsRemaining = 15 * 60; // 15 mins

// DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSocket();
  loadDashboardData();
  loadHistoryRecords();
  initFormListeners();
  initControls();

  // Periodic polling every 5s for new queue candidates
  setInterval(loadDashboardData, 5000);
});

// 1. Navigation & Tab Switching
function initTabs() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.tab;
      switchTab(targetId);
    });
  });
}

function switchTab(tabId) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

  const activeTab = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
  const activePanel = document.getElementById(tabId);

  if (activeTab) activeTab.classList.add('active');
  if (activePanel) activePanel.classList.add('active');
}

// 2. Real-time Socket.IO Connection
function initSocket() {
  try {
    socket = io();
    socket.on('connect', () => {
      console.log('✅ Connected to FRENVI signaling server:', socket.id);
    });

    // Listen for new instant assessment alerts
    socket.on('new_instant_assessment', (data) => {
      showToast(`⚡ New instant candidate in queue: ${data.userName || 'Worker'}`);
      loadDashboardData();
    });

    socket.on('peer_joined', (data) => {
      console.log('Candidate joined assessment room:', data);
      const st = document.getElementById('remote-status-text');
      if (st) st.textContent = 'Worker joined video room. Stream connecting...';
    });
  } catch (err) {
    console.warn('Socket.io initialization error:', err);
  }
}

// 3. Load Dashboard Data (Instant Queue & Scheduled Bookings)
async function loadDashboardData() {
  try {
    const res = await fetch('/api/assessments/admin/dashboard');
    const json = await res.json();
    if (!json.success) return;

    const { instantQueue, scheduledBookings, stats } = json.data;

    // Update Header Counts
    const qCount = instantQueue ? instantQueue.length : 0;
    const sCount = scheduledBookings ? scheduledBookings.length : 0;

    const elInstant = document.getElementById('metric-instant-count');
    const elSched = document.getElementById('metric-scheduled-count');
    const elQBadge = document.getElementById('queue-badge');
    const elSBadge = document.getElementById('sched-badge');

    if (elInstant) elInstant.textContent = qCount;
    if (elSched) elSched.textContent = sCount;
    if (elQBadge) elQBadge.textContent = qCount;
    if (elSBadge) elSBadge.textContent = sCount;

    // Render Instant Queue Cards
    renderInstantQueue(instantQueue);

    // Render Scheduled Table
    renderScheduledTable(scheduledBookings);
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
  }
}

function renderInstantQueue(queue) {
  const container = document.getElementById('instant-queue-list');
  if (!container) return;

  if (!queue || queue.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚡</div>
        <h3>No candidates currently in instant queue</h3>
        <p>When a worker selects "Instant Assessment" on the FRENVI app, their card will appear here instantly with one-click video room access.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = queue.map(cand => `
    <div class="queue-card">
      <div class="card-top">
        <div class="candidate-meta">
          <div class="meta-avatar">👷</div>
          <div>
            <div class="meta-name">${escapeHtml(cand.userName || 'Candidate')}</div>
            <div class="meta-phone">${escapeHtml(cand.userPhone || '')}</div>
          </div>
        </div>
        <div class="wait-timer">
          <span>⏱️</span>
          <span>Waiting Now</span>
        </div>
      </div>

      <div class="designation-badge">${escapeHtml(cand.designationTitle || 'Store Associate')}</div>

      <div class="card-chips">
        ${(cand.categoryNames || cand.categoryIds || []).map(c => `<span class="chip">${escapeHtml(c)}</span>`).join('')}
        <span class="chip">🗣️ ${escapeHtml(cand.language || 'English')}</span>
      </div>

      <button class="btn btn-primary" onclick="joinCandidateSession('${cand._id || cand.id}', '${cand.channelName}', '${escapeHtml(cand.userName)}', '${escapeHtml(cand.userPhone)}', '${escapeHtml(cand.designationTitle)}', '${escapeHtml(cand.language)}')">
        <span>🎥</span>
        <span>Join Video Assessment</span>
      </button>
    </div>
  `).join('');
}

function renderScheduledTable(bookings) {
  const tbody = document.getElementById('scheduled-table-body');
  if (!tbody) return;

  if (!bookings || bookings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 40px; color:#94A3B8;">No scheduled video appointments booked yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = bookings.map(b => `
    <tr>
      <td>
        <strong style="color:#FFF;">${escapeHtml(b.userName || 'Candidate')}</strong>
        <div style="font-size:12px; color:#94A3B8; font-family: monospace;">${escapeHtml(b.userPhone || '')}</div>
      </td>
      <td><span style="color:#3B82F6; font-weight:600;">${escapeHtml(b.designationTitle || 'Retail')}</span></td>
      <td><span style="font-size:12px; color:#94A3B8;">${(b.categoryNames || b.categoryIds || []).join(', ') || 'Standard'}</span></td>
      <td><span style="font-size:12px;">🗣️ ${escapeHtml(b.language || 'English')}</span></td>
      <td>
        <strong>${escapeHtml(b.scheduledDateFormatted || b.scheduledDate || '')}</strong>
        <div style="color:#F59E0B; font-weight:700; font-size:12px;">⏰ ${escapeHtml(b.slotTime || '')}</div>
      </td>
      <td><span class="status-pill confirmed">CONFIRMED</span></td>
      <td>
        <button class="btn btn-outline" style="padding:6px 12px; font-size:12px;" onclick="joinCandidateSession('${b._id || b.id}', '${b.channelName}', '${escapeHtml(b.userName)}', '${escapeHtml(b.userPhone)}', '${escapeHtml(b.designationTitle)}', '${escapeHtml(b.language)}')">
          Start Session
        </button>
      </td>
    </tr>
  `).join('');
}

// 4. Joining Assessment Session & Initializing Agora RTC
async function joinCandidateSession(assessmentId, channelName, userName, userPhone, designation, language) {
  currentCandidate = {
    assessmentId,
    channelName: channelName || `frenvi_room_${Date.now()}`,
    userName: userName || 'Worker Candidate',
    userPhone: userPhone || '9876543210',
    designation: designation || 'Food & Dining Crew',
    language: language || 'English'
  };

  // Update Room UI with Candidate Meta
  document.getElementById('room-candidate-name').textContent = currentCandidate.userName;
  document.getElementById('cand-name').textContent = currentCandidate.userName;
  document.getElementById('cand-phone').textContent = currentCandidate.userPhone;
  document.getElementById('cand-designation').textContent = currentCandidate.designation;
  document.getElementById('active-channel-name').textContent = currentCandidate.channelName;
  document.getElementById('cand-categories').innerHTML = `
    <span class="pill">Designation: ${escapeHtml(currentCandidate.designation)}</span>
    <span class="pill">Language: ${escapeHtml(currentCandidate.language)}</span>
    <span class="pill">15 Min Video Session</span>
  `;

  // Switch to Room Tab
  switchTab('room-tab');
  const liveTag = document.getElementById('room-live-tag');
  if (liveTag) liveTag.style.display = 'inline-block';

  // Join Agora Room
  await startAgoraCall(currentCandidate.channelName);

  // Join Socket.io Room for instant signalling
  if (socket) {
    socket.emit('join_assessment', currentCandidate.channelName);
  }

  // Start 15 Min Timer
  startCallTimer();
  showToast(`Connected to assessment session with ${currentCandidate.userName}`);
}

async function startAgoraCall(channelName) {
  try {
    const remotePlaceholder = document.getElementById('remote-placeholder');
    const remoteStatus = document.getElementById('remote-status-text');
    if (remoteStatus) remoteStatus.textContent = 'Requesting secure Agora RTC credentials...';

    // 1. Fetch Agora Token from Backend
    const tokenRes = await fetch(`/api/agora/token?channelName=${encodeURIComponent(channelName)}&uid=1001&role=publisher`);
    const tokenData = await tokenRes.json();

    if (!tokenData.success) {
      console.warn('Could not fetch Agora token, operating in preview simulation mode');
      if (remoteStatus) remoteStatus.textContent = 'Agora credentials pending. Waiting for worker camera...';
      return;
    }

    const { appId, token, uid } = tokenData.data;

    // Check if Agora RTC SDK is loaded
    if (typeof AgoraRTC === 'undefined') {
      console.warn('AgoraRTC Web SDK not loaded from CDN');
      if (remoteStatus) remoteStatus.textContent = 'Agora Web SDK loading...';
      return;
    }

    // 2. Initialize Client
    agoraClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

    // Handle Remote Candidate Stream
    agoraClient.on('user-published', async (user, mediaType) => {
      await agoraClient.subscribe(user, mediaType);
      console.log('Subscribed to worker candidate stream:', mediaType);

      if (mediaType === 'video') {
        const remoteContainer = document.getElementById('remote-video');
        if (remotePlaceholder) remotePlaceholder.style.display = 'none';
        user.videoTrack.play(remoteContainer);
      }
      if (mediaType === 'audio') {
        user.audioTrack.play();
      }
    });

    agoraClient.on('user-unpublished', (user, mediaType) => {
      if (mediaType === 'video' && remotePlaceholder) {
        remotePlaceholder.style.display = 'flex';
      }
    });

    // 3. Join Channel
    await agoraClient.join(appId, channelName, token || null, uid);
    console.log(`Assessor joined channel: ${channelName} with UID ${uid}`);

    // 4. Create and publish local assessor camera & microphone tracks
    try {
      localTracks.audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
      localTracks.videoTrack = await AgoraRTC.createCameraVideoTrack();

      const localContainer = document.getElementById('local-video');
      localTracks.videoTrack.play(localContainer);

      await agoraClient.publish([localTracks.audioTrack, localTracks.videoTrack]);
      console.log('Assessor local camera & mic published successfully');
    } catch (mediaErr) {
      console.warn('Camera/Microphone permission denied or device unavailable:', mediaErr.message);
      if (remoteStatus) remoteStatus.textContent = 'Assessor mic/cam preview inactive (Check browser permissions)';
    }

  } catch (err) {
    console.error('Error starting Agora call:', err);
  }
}

// 5. Live Scoring & Competency Rubric
function updateLiveScore() {
  const comm = Number(document.getElementById('slider-communication').value);
  const scenario = Number(document.getElementById('slider-scenario').value);
  const hygiene = Number(document.getElementById('slider-hygiene').value);
  const reliability = Number(document.getElementById('slider-reliability').value);

  // Update input text indicators
  document.getElementById('score-comm-val').textContent = `${comm} / 25`;
  document.getElementById('score-scenario-val').textContent = `${scenario} / 25`;
  document.getElementById('score-hygiene-val').textContent = `${hygiene} / 25`;
  document.getElementById('score-reliability-val').textContent = `${reliability} / 25`;

  const total = comm + scenario + hygiene + reliability;
  document.getElementById('live-total-score').textContent = total;

  const gradePill = document.getElementById('live-grade-pill');
  const badgeDisplay = document.getElementById('badge-name-display');

  if (total >= 90) {
    gradePill.className = 'grade-pill grade-a';
    gradePill.textContent = 'Grade A (Distinction)';
    badgeDisplay.textContent = 'Certified Senior Dining & Retail Specialist';
  } else if (total >= 80) {
    gradePill.className = 'grade-pill grade-a';
    gradePill.textContent = 'Grade A';
    badgeDisplay.textContent = 'Certified Store & Dining Specialist';
  } else if (total >= 70) {
    gradePill.className = 'grade-pill grade-b';
    gradePill.textContent = 'Grade B';
    badgeDisplay.textContent = 'Certified Associate Specialist';
  } else {
    gradePill.className = 'grade-pill grade-c';
    gradePill.textContent = 'Retake Required';
    badgeDisplay.textContent = 'Training Required for Certification';
  }

  // Send real-time draft score sync to candidate
  if (socket && currentCandidate) {
    socket.emit('update_draft_score', {
      roomId: currentCandidate.channelName,
      scores: { comm, scenario, hygiene, reliability },
      totalScore: total
    });
  }
}

// Expose globally for oninput
window.updateLiveScore = updateLiveScore;

// 6. Submit Evaluation
function initFormListeners() {
  const form = document.getElementById('evaluation-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!currentCandidate) {
      showToast('⚠️ No candidate selected. Please select a candidate from queue first.');
      return;
    }

    const comm = Number(document.getElementById('slider-communication').value);
    const scenario = Number(document.getElementById('slider-scenario').value);
    const hygiene = Number(document.getElementById('slider-hygiene').value);
    const reliability = Number(document.getElementById('slider-reliability').value);
    const feedback = document.getElementById('eval-feedback').value;

    const payload = {
      assessmentId: currentCandidate.assessmentId,
      userPhone: currentCandidate.userPhone,
      userName: currentCandidate.userName,
      assessorName: 'Priya Sharma (Lead Assessor)',
      scores: {
        communication: comm,
        scenarioHandling: scenario,
        hygieneSafety: hygiene,
        reliability: reliability
      },
      feedback: feedback
    };

    const submitBtn = document.getElementById('submit-eval-btn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>⏳</span><span>Recording Evaluation in MongoDB...</span>';

    try {
      const res = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.success) {
        showToast(`🎉 Verified ${currentCandidate.userName}! Score: ${data.data.totalScore}/100 (${data.data.grade})`);

        // Signal to candidate's mobile app via socket
        if (socket) {
          socket.emit('finish_assessment', {
            roomId: currentCandidate.channelName,
            evaluation: data.data
          });
        }

        // Clean up session
        leaveAssessmentCall();

        // Refresh records and switch to history
        loadDashboardData();
        loadHistoryRecords();
        switchTab('history-tab');
      } else {
        showToast(`Error: ${data.message || 'Submission failed'}`);
      }
    } catch (err) {
      console.error('Submit evaluation error:', err);
      showToast('⚠️ Server connection error while submitting evaluation');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>✅</span><span>Submit Evaluation & Verify Candidate</span>';
    }
  });

  const draftBtn = document.getElementById('save-draft-btn');
  if (draftBtn) {
    draftBtn.addEventListener('click', () => {
      showToast('📝 Evaluation draft auto-saved');
    });
  }

  const refreshQ = document.getElementById('refresh-queue-btn');
  if (refreshQ) refreshQ.addEventListener('click', () => {
    loadDashboardData();
    showToast('Queue refreshed');
  });

  const refreshH = document.getElementById('refresh-history-btn');
  if (refreshH) refreshH.addEventListener('click', () => {
    loadHistoryRecords();
    showToast('Records refreshed');
  });
}

// 7. Call Controls (Mic, Camera, End Call)
function initControls() {
  const micBtn = document.getElementById('toggle-mic-btn');
  const camBtn = document.getElementById('toggle-cam-btn');
  const leaveBtn = document.getElementById('leave-call-btn');

  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (localTracks.audioTrack) {
        isMicMuted = !isMicMuted;
        localTracks.audioTrack.setEnabled(!isMicMuted);
        document.getElementById('mic-icon').textContent = isMicMuted ? '🔇' : '🎙️';
        micBtn.querySelector('.control-text').textContent = isMicMuted ? 'Unmute' : 'Mute';
      }
    });
  }

  if (camBtn) {
    camBtn.addEventListener('click', () => {
      if (localTracks.videoTrack) {
        isCamOff = !isCamOff;
        localTracks.videoTrack.setEnabled(!isCamOff);
        document.getElementById('cam-icon').textContent = isCamOff ? '🚫' : '📹';
        camBtn.querySelector('.control-text').textContent = isCamOff ? 'Start Video' : 'Stop Video';
      }
    });
  }

  if (leaveBtn) {
    leaveBtn.addEventListener('click', () => {
      leaveAssessmentCall();
      switchTab('queue-tab');
    });
  }
}

async function leaveAssessmentCall() {
  if (localTracks.audioTrack) {
    localTracks.audioTrack.stop();
    localTracks.audioTrack.close();
  }
  if (localTracks.videoTrack) {
    localTracks.videoTrack.stop();
    localTracks.videoTrack.close();
  }
  if (agoraClient) {
    try {
      await agoraClient.leave();
    } catch (e) {}
  }
  clearInterval(timerInterval);
  const liveTag = document.getElementById('room-live-tag');
  if (liveTag) liveTag.style.display = 'none';

  const remotePlaceholder = document.getElementById('remote-placeholder');
  if (remotePlaceholder) remotePlaceholder.style.display = 'flex';
}

function startCallTimer() {
  clearInterval(timerInterval);
  secondsRemaining = 15 * 60;
  const timerEl = document.getElementById('call-timer');

  timerInterval = setInterval(() => {
    if (secondsRemaining <= 0) {
      clearInterval(timerInterval);
      return;
    }
    secondsRemaining--;
    const mins = Math.floor(secondsRemaining / 60);
    const secs = secondsRemaining % 60;
    if (timerEl) {
      timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
  }, 1000);
}

// 8. Evaluation History Records
async function loadHistoryRecords() {
  try {
    const res = await fetch('/api/evaluations/all');
    const json = await res.json();
    if (!json.success) return;

    const list = json.data || [];
    const container = document.getElementById('history-cards-container');
    if (!container) return;

    if (list.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📜</div>
          <h3>No evaluations conducted yet</h3>
          <p>When candidates are evaluated and verified through video calls, their scores and unlocked shifts will be archived here.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = list.map(item => `
      <div class="history-card">
        <div class="hist-top">
          <div class="hist-name">${escapeHtml(item.userPhone || (item.userId && item.userId.name) || 'Worker Candidate')}</div>
          <div class="hist-score">${item.totalScore} / 100</div>
        </div>

        <div class="hist-badge">
          <span>🎖️</span>
          <span>${escapeHtml(item.skillBadge || 'Verified Associate')}</span>
          <span class="grade-pill grade-a" style="margin-left: auto;">${escapeHtml(item.grade || 'Grade A')}</span>
        </div>

        <div class="hist-feedback">
          "${escapeHtml(item.feedback || 'Candidate passed assessment')}"
        </div>

        <div style="font-size: 11px; color:#64748B; font-family: monospace;">
          Assessed by: ${escapeHtml(item.assessorName || 'Priya Sharma')} • ${new Date(item.evaluatedAt || Date.now()).toLocaleDateString()}
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load history records:', err);
  }
}

// Toast Helper
function showToast(msg) {
  const t = document.getElementById('admin-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

// HTML Escape helper
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Window join helper for inline HTML buttons
window.joinCandidateSession = joinCandidateSession;
