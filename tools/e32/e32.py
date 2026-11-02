import struct, sys, os
sys.path.insert(0, os.path.dirname(__file__))
import e32dec
def load(path):
    b = open(path,'rb').read()
    (u1,u2,u3,chk,sig), h = e32dec.parse_header_exact(b)
    h['uids']=(u1,u2,u3)
    import sinflate
    if h['comp_type']==0x101F7AFC:
        unc=struct.unpack_from('<I',b,128)[0]
        img=b[:h['code_off']]+sinflate.inflate(b[h['code_off']:],unc)
    else:
        hh, img = e32dec.decompress_image(b)
    if img is None: raise Exception('decomp fail '+path)
    h['img']=img
    co=h['code_off']; cs=h['code_size']
    h['code']=img[co:co+cs]
    h['data']=img[h['data_off']:h['data_off']+h['data_size']] if h['data_size'] else b''
    # exports: export_off is file offset into image
    eo=h['export_off']; n=h['export_cnt']
    h['exports']=list(struct.unpack_from('<%dI'%n, img, eo)) if n else []
    # imports
    imps=[]
    io=h['import_off']
    if io:
        sz=struct.unpack_from('<I',img,io)[0]
        p=io+4
        for i in range(h['dll_ref']):
            no,cnt=struct.unpack_from('<II',img,p); p+=8
            name=img[io+no:img.index(b'\0',io+no)].decode('latin1')
            ords=list(struct.unpack_from('<%dI'%cnt,img,p)); p+=4*cnt
            if (h['flags']>>28)&0xf==1:
                code=img[h['code_off']:h['code_off']+h['code_size']]
                ords=[(o, struct.unpack_from('<I',code,o)[0]) for o in ords]
            imps.append((name,ords))
    h['imports']=imps
    # code relocs
    def relocs(off):
        out=[]
        if not off: return out
        size,num=struct.unpack_from('<II',img,off); p=off+8; end=off+8+size
        while p<end:
            page,bs=struct.unpack_from('<II',img,p)
            for k in range((bs-8)//2):
                e=struct.unpack_from('<H',img,p+8+2*k)[0]
                if e: out.append((page+(e&0xfff), e>>12))
            p+=bs
        return out
    h['crelocs']=relocs(h['creloc']); h['drelocs']=relocs(h['dreloc'])
    return h
if __name__=='__main__':
    for p in sys.argv[1:]:
        h=load(p)
        print('==',os.path.basename(p),'uids %08x %08x %08x'%h['uids'],'code_base %x data_base %x code %x data %x bss %x entry %x'%(h['code_base'],h['data_base'],h['code_size'],h['data_size'],h['bss'],h['entry']), 'flags %x'%h['flags'])
        print(' exports(%d):'%len(h['exports']), ' '.join('%d:%x'%(i+1,e) for i,e in enumerate(h['exports'])))
        for n,o in h['imports']:
            if o and isinstance(o[0],tuple): print(' import',n,' '.join('%x@%x'%(v&0xffff,off+h['code_base']) for off,v in o))
            else: print(' import',n,o)
