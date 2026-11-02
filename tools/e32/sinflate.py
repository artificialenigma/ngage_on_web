# Symbian "deflate" (Huffman+LZ77, KUidCompressionDeflate 0x101F7AFC) decoder
META = [0x0004006c,0x00040064,0x0004005c,0x00040050,0x00040044,0x0004003c,0x00040034,0x00040021,0x00040023,0x00040025,0x00040027,0x00040029,0x00040014,0x0004000c,0x00040035,0x00390037,0x00330031,0x0004002b,0x002f002d,0x001f001d,0x001b0019,0x00040013,0x00170015,0x0004000d,0x0011000f,0x000b0009,0x00070003,0x00050001]
class Bits:
    def __init__(s,d): s.d=d; s.p=0
    def bit(s):
        b=(s.d[s.p>>3]>>(7-(s.p&7)))&1; s.p+=1; return b
    def read(s,n):
        v=0
        for _ in range(n): v=(v<<1)|s.bit()
        return v
    def meta(s):
        idx=0; huff=0
        while True:
            idx+= (huff>>16)//4
            huff=META[idx]
            if s.bit()==0: huff=(huff<<16)&0xffffffff
            if huff&0x10000: return huff>>17
def internalize(bi,n):
    lst=list(range(28)); last=0; out=[]; rl=0
    while len(out)+rl<n:
        c=bi.meta()
        if c<2: rl+=rl+c+1
        else:
            out+= [last]*rl; rl=0
            c-=1
            lst.insert(0,last); last=lst.pop(c+1) if False else None
            # emulate: list[0]=last; last=list[c]; memmove(list+1,list,c)
            lst.pop(0)
            l2=lst[:]; l2[0]=out[-1] if False else l2[0]
            raise SystemExit
    return out
def internalize(bi,n):
    lst=list(range(28)); last=0; out=[]; rl=0
    while len(out)+rl<n:
        c=bi.meta()
        if c<2: rl+=rl+c+1
        else:
            out+=[last]*rl; rl=0
            c-=1
            lst[0]=last
            last=lst[c]
            lst[1:c+1]=lst[0:c]
            out.append(last)
    out+=[last]*rl
    return out[:n]
class Canon:
    def __init__(s,lens):
        s.t={}
        cnt=[0]*28
        for l in lens:
            if l: cnt[l]+=1
        code=0; nxt=[0]*29
        for L in range(1,28):
            code=(code+cnt[L-1])<<1 if L>1 else 0
            nxt[L]=code
        # recompute properly
        code=0
        for L in range(1,28):
            nxt[L]=code; code=(code+cnt[L])<<1
        for sym,l in enumerate(lens):
            if l: s.t[(l,nxt[l])]=sym; nxt[l]+=1
    def dec(s,bi):
        c=0;L=0
        while True:
            c=(c<<1)|bi.bit(); L+=1
            r=s.t.get((L,c))
            if r is not None: return r
            if L>27: raise ValueError('bad code')
def inflate(data, outsize):
    bi=Bits(data)
    lens=internalize(bi,329)
    lit=Canon(lens[:285]); dist=Canon(lens[285:])
    out=bytearray()
    def xtra(code):
        if code>=8:
            x=(code>>2)-1; code-=x<<2; code<<=x; code|=bi.read(x)
        return code
    while len(out)<outsize:
        v=lit.dec(bi)
        if v<256: out.append(v); continue
        if v==284: break
        ln=xtra(v-256)+3
        d=xtra(dist.dec(bi))+1
        for _ in range(ln): out.append(out[-d])
    return bytes(out)
