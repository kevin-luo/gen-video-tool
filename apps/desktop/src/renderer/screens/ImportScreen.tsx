import {AlertTriangle, ArrowLeft, CheckCircle2, FileArchive, RefreshCcw, ShieldCheck, XCircle} from 'lucide-react';
import {WorkflowSteps} from '../components/WorkflowSteps';
import type {ValidationReport} from '../domain/editor';

interface ImportScreenProps {
  report: ValidationReport;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onReselect: () => void;
  onEnterEditor: () => void;
}

export function ImportScreen({report, busy, error, onBack, onReselect, onEnterEditor}: ImportScreenProps) {
  const errors = report.checks.filter((check) => check.status === 'error').length;
  const warnings = report.checks.filter((check) => check.status === 'warning').length;
  const passes = report.checks.filter((check) => check.status === 'pass').length;

  return (
    <main className="import-shell">
      <header className="simple-header">
        <button type="button" className="button button--ghost" onClick={onBack}><ArrowLeft size={16} /> 返回项目</button>
        <div className="brand-lockup brand-lockup--compact"><FileArchive size={18} /> 资产包检查</div>
        <span className="simple-header__spacer" />
      </header>

      <section className="import-content" aria-labelledby="import-title">
        <WorkflowSteps current="assets" compact />
        <div className="import-titlebar">
          <div className={`validation-seal ${errors ? 'validation-seal--error' : 'validation-seal--success'}`}>
            {errors ? <XCircle size={26} /> : <ShieldCheck size={26} />}
          </div>
          <div>
            <p className="eyebrow">v3 生产门禁</p>
            <h1 id="import-title">{errors ? '资产包需要修复' : '资产包可以进入编辑器'}</h1>
            <p>{errors ? '当前版本仅接受完整的 v3 生产契约；修复阻断项后重新检查。' : `已通过 ${passes} 项检查，${warnings} 个提醒不会阻止本地制作。`}</p>
          </div>
        </div>

        <div className="import-layout">
          <aside className="pack-summary" aria-label="资产包信息">
            <div className="pack-summary__icon"><FileArchive size={28} /></div>
            <h2>{report.projectName}</h2>
            <p className="path-text" title={report.path}>{report.path}</p>
            <dl>
              <div><dt>生产契约</dt><dd>Gen Video v{report.manifestVersion}</dd></div>
              <div><dt>镜头</dt><dd>{report.shots}</dd></div>
              <div><dt>文件</dt><dd>{report.files}</dd></div>
              <div><dt>阻断项</dt><dd className={errors ? 'text-error' : 'text-success'}>{errors}</dd></div>
            </dl>
            <button type="button" className="button button--ghost button--full" onClick={onReselect}><RefreshCcw size={15} /> 重新选择资产包</button>
          </aside>

          <section className="check-panel" aria-labelledby="check-title">
            <div className="check-panel__header">
              <div><h2 id="check-title">生产门禁</h2><p>检查关键帧、镜头逻辑、配音输入和安全路径；素材不会上传。</p></div>
              <span>{report.checks.length} 项</span>
            </div>
            <ul className="check-list">
              {report.checks.map((check) => (
                <li key={check.id} className={`check-row check-row--${check.status}`}>
                  <span className="check-row__icon">
                    {check.status === 'pass' ? <CheckCircle2 size={19} /> : check.status === 'warning' ? <AlertTriangle size={19} /> : <XCircle size={19} />}
                  </span>
                  <span className="check-row__content"><strong>{check.label}</strong><small>{check.detail}</small></span>
                  <span className="check-row__status">{check.status === 'pass' ? '通过' : check.status === 'warning' ? '提醒' : '阻断'}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="import-footer">
          <p role={error ? 'alert' : undefined}>{error ?? (errors ? '存在阻断项，暂时不能建立本地项目。' : '通过后会建立独立项目目录，并保留检查记录。')}</p>
          <button type="button" className="button button--primary button--large" disabled={errors > 0 || busy} onClick={onEnterEditor}>{busy ? '正在建立项目…' : '建立本地项目'}</button>
        </footer>
      </section>
    </main>
  );
}
