// ===== Materials (20°C) =====
    const materials = {
      copper:   { resistivity: 1.724e-8, density: 8.96, name: 'Copper',   tempCoeff: 0.00393 },
      aluminum: { resistivity: 2.82e-8,  density: 2.70, name: 'Aluminum', tempCoeff: 0.00403 },
      silver:   { resistivity: 1.59e-8,  density: 10.49, name: 'Silver',  tempCoeff: 0.0038 }
    };

    // ===== UI helpers =====
    const coilShapeRadios = document.getElementsByName('coilShape');
    const wireShapeRadios = document.getElementsByName('wireShape');
    const radioOptions = document.querySelectorAll('.radio-option');

    coilShapeRadios.forEach(r => r.addEventListener('change', updateUI));
    wireShapeRadios.forEach(r => r.addEventListener('change', updateUI));
    radioOptions.forEach(opt => {
      opt.addEventListener('click', function(){
        const radio = this.querySelector('input[type="radio"]');
        const group = radio.name;
        document.querySelectorAll(`input[name="${group}"]`).forEach(r => r.closest('.radio-option').classList.remove('selected'));
        this.classList.add('selected'); radio.checked = true; updateUI();
      });
    });

    function updateUI(){
      const coilShape = document.querySelector('input[name="coilShape"]:checked').value;
      const wireShape = document.querySelector('input[name="wireShape"]:checked').value;
      document.getElementById('rect-coil-dims').classList.toggle('hidden', coilShape !== 'rectangular');
      document.getElementById('circ-coil-dims').classList.toggle('hidden', coilShape !== 'circular');
      document.getElementById('rect-wire-dims').classList.toggle('hidden', wireShape !== 'rectangular');
      document.getElementById('circ-wire-dims').classList.toggle('hidden', wireShape !== 'circular');
    }

    function showError(msg){
      document.getElementById('error-message').textContent = msg;
      document.getElementById('error-container').classList.remove('hidden');
      document.getElementById('results-container').classList.remove('show');
    }
    function hideError(){ document.getElementById('error-container').classList.add('hidden'); }

    // ===== Physics =====
    const MU0 = 4 * Math.PI * 1e-7; // H/m

    // Mohan rectangular spiral (using arithmetic-mean “rectangular diameters”)
    // L = μ0 * N^2 * (d_avg/2) * [ ln(2.46/ρ) + 0.2 ρ^2 ]
    function mohanRectangularSpiral_L(A_in_mm, B_in_mm, A_out_mm, B_out_mm, N){
      const D_out = (A_out_mm + B_out_mm)/2;
      const D_in  = (A_in_mm  + B_in_mm )/2;
      if (D_out <= D_in || N <= 0) return 0;
      let rho = (D_out - D_in) / (D_out + D_in);
      rho = Math.max(1e-6, Math.min(0.999999, rho));
      const d_avg_m = ( (D_out + D_in)/2 ) / 1000;
      const bracket = Math.log(2.46/rho) + 0.2 * rho * rho;
      return MU0 * (N*N) * (d_avg_m/2) * bracket; // [H]
    }

    // Smoothstep 0→1
    function smoothstep01(s){ s = Math.max(0, Math.min(1, s)); return 3*s*s - 2*s*s*s; }

    // Multilayer coupling scale (reduces from m^2 toward ~m as vertical spacing grows)
    function multilayerCouplingScale(m, d_avg_mm, verticalPitch_mm){
      if (m <= 1) return 1;
      const p = 1.5;
      const d = Math.max(1e-9, d_avg_mm), dz = verticalPitch_mm;
      let scale = m; // self terms
      for (let Δ=1; Δ<=m-1; Δ++){
        const kz = 1 / (1 + Math.pow(((Δ*dz)/d), p));
        scale += 2 * (m-Δ) * kz;
      }
      return scale; // multiplies n^2 already included in single-layer L
    }

    // Mutual + self for circular loops (filament method)
    function mutualInductanceCircular(r1, r2, z){
      if (r1 <= 0 || r2 <= 0) return 0;
      const k2 = (4 * r1 * r2) / ((r1 + r2)**2 + z**2);
      if (k2 >= 1) return 0;
      const k = Math.sqrt(k2);
      const m = k2, m1 = 1 - m;
      const a = [1.38629436112, 0.09666344259, 0.03590092383, 0.03742563713, 0.01451196212];
      const b = [0.5, 0.12498593597, 0.06880248576, 0.03328355346, 0.00441787012];
      const K = a[0] + m1*(a[1] + m1*(a[2] + m1*(a[3] + m1*a[4])))
              - (b[0] + m1*(b[1] + m1*(b[2] + m1*(b[3] + m1*b[4])))) * Math.log(m1);
      const c = [1, 0.44325141463, 0.06260601220, 0.04757383546, 0.01736506451];
      const d = [0.24998368310, 0.09200180037, 0.04069697526, 0.0112720893, 0.00287315302];
      const E = c[0] + m1*(c[1] + m1*(c[2] + m1*(c[3] + m1*c[4])))
              - (m1 * Math.log(m1)) * (d[0] + m1*(d[1] + m1*(d[2] + m1*(d[3] + m1*d[4]))));
      return (MU0 * Math.sqrt(r1*r2) / k) * ((2 - k2) * K - 2 * E);
    }
    function selfInductanceCircular(r, wireRadius){
      if (r <= 0 || wireRadius <= 0 || 8*r/wireRadius <= 0) return 0;
      return MU0 * r * (Math.log(8 * r / wireRadius) - 1.75);
    }

    function calculate(){
      hideError();
      try{
        const coilShape = document.querySelector('input[name="coilShape"]:checked').value;
        const wireShape = document.querySelector('input[name="wireShape"]:checked').value;
        const material  = materials[ document.getElementById('wireMaterial').value ];

        const n  = parseInt(document.getElementById('n').value);
        const m  = parseInt(document.getElementById('m').value);
        const s_h= parseFloat(document.getElementById('s_h').value);
        const s_v= parseFloat(document.getElementById('s_v').value);
        if (n<=0 || m<=0) throw new Error('Number of turns and layers must be greater than 0.');

        let wireWidth, wireThickness, area_mm2, wireRadius_mm;
        if (wireShape === 'rectangular'){
          wireWidth = parseFloat(document.getElementById('W_d').value);
          wireThickness = parseFloat(document.getElementById('t').value);
          if (wireWidth<=0 || wireThickness<=0) throw new Error('Wire dimensions must be greater than 0.');
          area_mm2 = wireWidth * wireThickness;
          wireRadius_mm = Math.sqrt(area_mm2 / Math.PI); // effective radius for AC/inductance
        } else {
          const dia = parseFloat(document.getElementById('a').value);
          if (dia<=0) throw new Error('Wire diameter must be greater than 0.');
          wireWidth = dia; wireThickness = dia;
          wireRadius_mm = dia/2;
          area_mm2 = Math.PI * (wireRadius_mm**2);
        }

        const pitch = wireWidth + s_h;
        let singleLayerLength_mm = 0;
        let coilSizeStr = '';
        let inductance_H = 0;

        if (coilShape === 'rectangular'){
          const A = parseFloat(document.getElementById('A').value); // mm
          const B = parseFloat(document.getElementById('B').value); // mm
          const R = parseFloat(document.getElementById('R').value) || 0;

          if (A<=0 || B<=0) throw new Error('Coil inner dimensions must be greater than 0.');
          if (2*R > Math.min(A,B)) {
            // === Full circle (inner shape already circular) → switch to circular mode ===
            const innerDiam = Math.min(A,B); // equals 2R at this condition
            singleLayerLength_mm = 0;
            for (let i=0;i<n;i++){
              const d = innerDiam + wireWidth + 2*i*pitch;
              singleLayerLength_mm += Math.PI * d;
            }
            const radialThickness = n*wireWidth + Math.max(0,(n-1)*s_h);
            const windingHeight   = m*wireThickness + Math.max(0,(m-1)*s_v);
            const outerDiam = innerDiam + 2*radialThickness;
            coilSizeStr = `⌀ ${outerDiam.toFixed(2)} × ${windingHeight.toFixed(2)} mm`;

            // Filament sum (m layers)
            const loops = [];
            const vPitch = wireThickness + s_v;
            for (let j=0;j<m;j++){
              for (let i=0;i<n;i++){
                const r = (innerDiam/2) + (i*pitch) + (wireWidth/2);
                const z = j * vPitch;
                loops.push({ r: r/1000, z: z/1000 });
              }
            }
            let L = 0;
            for (let i=0;i<loops.length;i++){
              L += selfInductanceCircular(loops[i].r, (wireWidth/2)/1000);
              for (let j=i+1;j<loops.length;j++){
                L += 2 * mutualInductanceCircular(loops[i].r, loops[j].r, Math.abs(loops[i].z - loops[j].z));
              }
            }
            inductance_H = L;

          } else {
            // === Rounded-rectangle: length with filleted corners (for display/length) ===
            singleLayerLength_mm = 0;
            for (let i=0;i<n;i++){
              const off = i*pitch + wireWidth/2;
              const curA = A + 2*off, curB = B + 2*off, curR = R + off;
              const straightA = Math.max(0, curA - 2*curR);
              const straightB = Math.max(0, curB - 2*curR);
              const turnLen = 2*(straightA + straightB) + 2*Math.PI*curR;
              singleLayerLength_mm += turnLen;
            }

            const radialThickness = n*wireWidth + Math.max(0,(n-1)*s_h);
            const windingHeight   = m*wireThickness + Math.max(0,(m-1)*s_v);
            const outerA = A + 2*radialThickness;
            const outerB = B + 2*radialThickness;
            coilSizeStr = `${outerA.toFixed(2)} × ${outerB.toFixed(2)} × ${windingHeight.toFixed(2)} mm`;

            // --- Baseline L_square: Mohan rectangular (R=0 model) ---
            const L_square = mohanRectangularSpiral_L(A, B, outerA, outerB, n); // already includes n^2

            // --- Endpoint L_circle: full circle at R = min(A,B)/2, using filament method ---
            const innerDiam_end = Math.min(A,B); // circle when R reaches half of min side
            const loops_end = [];
            for (let i=0;i<n;i++){
              const r = (innerDiam_end/2) + (i*pitch) + (wireWidth/2);
              const z = 0; // single layer for endpoint baseline; multilayer handled by scaleN2 below
              loops_end.push({ r: r/1000, z: z/1000 });
            }
            let L_circ_end = 0;
            for (let i=0;i<loops_end.length;i++){
              L_circ_end += selfInductanceCircular(loops_end[i].r, (wireWidth/2)/1000);
              for (let j=i+1;j<loops_end.length;j++){
                L_circ_end += 2 * mutualInductanceCircular(loops_end[i].r, loops_end[j].r, 0);
              }
            }

            // --- Blend by curvature progress s = R / (min(A,B)/2) (smoothstep) ---
            const s = (R) / (Math.min(A,B)/2);
            const f = smoothstep01(s);
            const L_singleLayer = L_square - (L_square - L_circ_end) * f; // continuous, exact at endpoints

            // --- Multilayer coupling scale ---
            const D_in_rect  = (A + B)/2;
            const D_out_rect = (outerA + outerB)/2;
            const d_avg_mm   = 0.5*(D_in_rect + D_out_rect);
            const vPitch     = wireThickness + s_v;
            const scaleN2    = multilayerCouplingScale(m, d_avg_mm, vPitch);

            // Final L (note: L_singleLayer already has n^2; do NOT divide by n^2)
            inductance_H = L_singleLayer * scaleN2;
          }

        } else {
          // ===== Circular coil path (explicit circular) =====
          const innerDiam = parseFloat(document.getElementById('innerDimCirc').value);
          if (innerDiam <= 0) throw new Error('Coil inner diameter must be greater than 0.');

          singleLayerLength_mm = 0;
          for (let i=0;i<n;i++){
            const d = innerDiam + wireWidth + 2*i*pitch;
            singleLayerLength_mm += Math.PI * d;
          }

          const radialThickness = n*wireWidth + Math.max(0,(n-1)*s_h);
          const windingHeight   = m*wireThickness + Math.max(0,(m-1)*s_v);
          const outerDiam = innerDiam + 2*radialThickness;
          coilSizeStr = `⌀ ${outerDiam.toFixed(2)} × ${windingHeight.toFixed(2)} mm`;

          const loops = [];
          const vPitch = wireThickness + s_v;
          for (let j=0;j<m;j++){
            for (let i=0;i<n;i++){
              const r = (innerDiam/2) + (i*pitch) + (wireWidth/2);
              const z = j * vPitch;
              loops.push({ r: r/1000, z: z/1000 });
            }
          }
          let L = 0;
          for (let i=0;i<loops.length;i++){
            L += selfInductanceCircular(loops[i].r, (wireWidth/2)/1000);
            for (let j=i+1;j<loops.length;j++){
              L += 2 * mutualInductanceCircular(loops[i].r, loops[j].r, Math.abs(loops[i].z - loops[i].z));
            }
          }
          inductance_H = L;
        }

        // ===== Scalar results =====
        const totalLength_mm = singleLayerLength_mm * m;
        const totalLength_m  = totalLength_mm / 1000;
        const area_m2        = area_mm2 / 1_000_000;
        const dcResistance   = material.resistivity * totalLength_m / area_m2;
        const wireWeight     = material.density * area_mm2 * totalLength_mm / 1000;

        // display
        document.getElementById('coil-size').innerHTML   = `${coilSizeStr}`;
        document.getElementById('total-length').innerHTML= `${totalLength_m.toFixed(3)} <span class="result-unit">m</span>`;
        document.getElementById('dc-resistance').innerHTML = `${dcResistance.toFixed(4)} <span class="result-unit">Ω</span>`;
        document.getElementById('wire-weight').innerHTML   = `${wireWeight.toFixed(1)} <span class="result-unit">g</span>`;

        let Ldisp, Lunit;
        if (inductance_H * 1000 >= 1){ Ldisp = inductance_H * 1000; Lunit = 'mH'; }
        else { Ldisp = inductance_H * 1e6; Lunit = 'µH'; }
        document.getElementById('inductance').innerHTML = `${Ldisp.toFixed(3)} <span class="result-unit">${Lunit}</span>`;

        const cshape = document.querySelector('input[name="coilShape"]:checked').value;
        const methodTxt = (cshape === 'circular')
          ? 'Filament method (self + mutual) for circular loops'
          : 'Mohan (rectangular, arithmetic-mean diameters) ↔ Circular (filament) smooth blending by R; multilayer coupling applied';
        document.getElementById('formula-display').innerHTML = `
          <strong>DC Resistance:</strong> R = ρ × L / A<br>
          <strong>Weight:</strong> W = Density × Volume<br>
          <strong>Inductance (${cshape}):</strong> ${methodTxt}<br>
          <strong>Note:</strong> If R ≥ min(A,B)/2, inner shape becomes a circle → circular mode.<br>
          <strong>Material:</strong> ${material.name} (at 20°C)
        `;

        document.getElementById('results-container').classList.add('show');

      } catch(err){
        showError(err.message);
      }
    }

    function exportResults(){
      const results = {
        coilSize: document.getElementById('coil-size').innerText,
        totalLength: document.getElementById('total-length').innerText,
        dcResistance: document.getElementById('dc-resistance').innerText,
        wireWeight: document.getElementById('wire-weight').innerText,
        inductance: document.getElementById('inductance').innerText,
        timestamp: new Date().toLocaleString()
      };
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(results, null, 2));
      const a = document.createElement('a');
      a.setAttribute('href', dataStr);
      a.setAttribute('download', 'coil_calculation_results.json');
      document.body.appendChild(a); a.click(); a.remove();
    }
    function printResults(){ window.print(); }
    function shareResults(){
      const resultsText = `Coil Calculation Results
Size: ${document.getElementById('coil-size').innerText}
Inductance: ${document.getElementById('inductance').innerText}
DC Resistance: ${document.getElementById('dc-resistance').innerText}`;
      if (navigator.share){
        navigator.share({ title: 'Coil Calculation Results', text: resultsText });
      } else {
        navigator.clipboard.writeText(resultsText).then(()=>alert('Results copied to clipboard!'));
      }
    }

    document.addEventListener('DOMContentLoaded', updateUI);
