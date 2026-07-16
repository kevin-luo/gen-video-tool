import {Check, Download, LoaderCircle, PackageOpen, TriangleAlert} from 'lucide-react';
import {useEffect, useState} from 'react';
import type {TemplateMarketEntry} from '../../shared/desktop-api';
import {Modal} from '../components/Modal';
import {desktopService} from '../services/desktop-service';

export function TemplateMarketDialog({onClose}: {onClose: () => void}) {
  const [templates, setTemplates] = useState<TemplateMarketEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void desktopService.listTemplates().then((entries) => {
      setTemplates(entries);
      setBusyId(null);
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : '读取模板目录失败');
      setBusyId(null);
    });
  }, []);

  const install = async (id: string) => {
    setError(null);
    setBusyId(id);
    try { setTemplates(await desktopService.installTemplate(id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '安装模板失败'); }
    finally { setBusyId(null); }
  };

  return (
    <Modal title="本地模板目录" description="安装经过结构校验的镜头、动作与世界规则组合；不下载不明代码。" width="wide" onClose={onClose} footer={<button type="button" className="button button--ghost" onClick={onClose}>关闭</button>}>
      {busyId === 'loading' ? <div className="template-market-loading" role="status"><LoaderCircle className="spin" size={20} />正在读取模板目录…</div> : null}
      {error ? <div className="inline-note inline-note--error" role="alert"><TriangleAlert size={15} />{error}</div> : null}
      <ol className="template-market-list">
        {templates.map((template, index) => (
          <li key={template.id}>
            <span className="template-market-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="template-market-copy"><span>{template.category} · v{template.version}</span><h3>{template.name}</h3><p>{template.summary}</p><small>{[...template.recipes, ...template.actions].slice(0, 5).join(' · ')}</small></div>
            <button type="button" className={template.installed ? 'button button--quiet' : 'button button--primary'} disabled={template.installed || busyId === template.id} onClick={() => void install(template.id)}>
              {busyId === template.id ? <LoaderCircle className="spin" size={15} /> : template.installed ? <Check size={15} /> : <Download size={15} />}
              {template.installed ? '已安装' : busyId === template.id ? '安装中' : '安装模板'}
            </button>
          </li>
        ))}
      </ol>
      {!busyId && !templates.length && !error ? <div className="template-market-loading"><PackageOpen size={22} />目录中还没有模板</div> : null}
    </Modal>
  );
}
