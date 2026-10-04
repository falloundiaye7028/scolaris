(() => {
  const money = value => BigInt(value).toLocaleString('fr-FR') + ' FCFA';
  window.ScolarisAmy = {
    async mount(root, api, profile) {
      const status = await api('/amy/status');
      if (!root.isConnected) return;
      const paused = profile.school_status === 'suspended' && !profile.platformAdmin;
      root.innerHTML = '<section class="panel"><h2>AMY IA · votre assistante administrative</h2><p>Posez vos questions sur SCOLARIS, analysez les totaux de votre établissement ou préparez un brouillon de synthèse.</p><p class="amy-note">Les indicateurs partagés avec AMY sont des totaux, toutes années scolaires confondues. Les listes nominatives ne sont pas envoyées automatiquement. Évitez les données personnelles dans vos questions.</p><div class="amy-suggestions"><button type="button" class="ghost">Résume la situation financière de l’établissement.</button><button type="button" class="ghost">Comment enregistrer un paiement reçu ?</button><button type="button" class="ghost">Prépare un modèle de relance courtoise.</button></div><div class="amy-thread" role="log" aria-label="Conversation avec AMY" aria-live="polite"></div><p class="amy-status" role="status"></p><form class="amy-form"><label for="amy-question">Votre question à AMY</label><textarea id="amy-question" rows="3" maxlength="2000" required placeholder="Exemple : quelles sont les priorités de recouvrement ?"></textarea><div class="amy-actions"><small>20 questions par heure et par utilisateur · 50 par jour pour l’établissement.</small><button class="action" type="submit">Envoyer à AMY</button></div></form><p class="amy-note">AMY peut se tromper : vérifiez les chiffres et les brouillons avant utilisation. Elle ne modifie aucune donnée et n’envoie aucun message. La conversation disparaît lorsque vous quittez cet onglet.</p></section>';
      const form = root.querySelector('form'), input = root.querySelector('textarea'), button = form.querySelector('button');
      const thread = root.querySelector('.amy-thread'), state = root.querySelector('.amy-status');
      const history = [];
      let pending = false;
      const available = status.enabled && !paused;
      input.disabled = button.disabled = !available;
      if (!available) state.textContent = paused ? 'AMY sera disponible après la réactivation de votre abonnement.' : 'La connexion à AMY est en cours de configuration.';
      root.querySelectorAll('.amy-suggestions button').forEach(item => {
        item.disabled = !available;
        item.onclick = () => { if (!pending) { input.value = item.textContent; input.focus(); } };
      });
      function append(label, text, className) {
        const box = document.createElement('article'), heading = document.createElement('strong'), content = document.createElement('p');
        box.className = 'amy-message ' + className;
        heading.textContent = label; content.textContent = text;
        box.append(heading,content); thread.append(box); box.scrollIntoView({block:'nearest'});
        return box;
      }
      form.onsubmit = async event => {
        event.preventDefault();
        const question = input.value.trim();
        if (!question || pending || !available) return;
        pending = true; button.disabled = input.disabled = true; button.textContent = 'AMY réfléchit…'; state.textContent = '';
        const outgoing = append('Vous',question,'amy-user');
        try {
          const result = await api('/amy/chat',{method:'POST',body:JSON.stringify({question,history:history.slice(-4).map(x=>({...x,content:x.content.slice(0,2000)}))})});
          if (!form.isConnected) return;
          append('AMY IA',result.answer,'amy-answer');
          const s = result.snapshot;
          append('Indicateurs utilisés', 'Toutes années scolaires · '+new Date(s.computedAt).toLocaleString('fr-FR')+'\nAttendu : '+money(s.expectedXof)+' · Payé : '+money(s.paidXof)+' · Reste : '+money(s.balanceXof)+'\nImpayés échus : '+money(s.overdueXof)+' pour '+s.overdueInvoices+' échéance(s).','amy-source');
          history.push({role:'user',content:question},{role:'assistant',content:result.answer});
          if (history.length > 4) history.splice(0,history.length-4);
          input.value = '';
        } catch (error) {
          outgoing.remove();
          if (form.isConnected) state.textContent = error.message || 'AMY est indisponible. Réessayez plus tard.';
        } finally {
          pending = false; button.disabled = input.disabled = false; button.textContent = 'Envoyer à AMY';
          if (form.isConnected) input.focus();
        }
      };
    },
  };
})();
