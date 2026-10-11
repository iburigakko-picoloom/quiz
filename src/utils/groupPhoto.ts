export const isGroupPhoto=(value:unknown):value is string=>typeof value==='string'&&value.length<=100000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);

export async function prepareGroupPhoto(file:File):Promise<string>{
  if(!file.type.startsWith('image/')||file.type==='image/svg+xml'||file.size>20*1024*1024)throw Error('20MB以下の写真を選んでください。');
  const url=URL.createObjectURL(file);
  try{
    const image=new Image();image.src=url;
    try{await image.decode();}catch{throw Error('この写真を読み込めません。JPEGまたはPNGの写真を選んでください。');}
    const canvas=document.createElement('canvas');canvas.width=canvas.height=240;
    const context=canvas.getContext('2d');if(!context)throw Error('写真を加工できませんでした。');
    const edge=Math.min(image.naturalWidth,image.naturalHeight);
    context.fillStyle='#fff';context.fillRect(0,0,240,240);
    context.drawImage(image,(image.naturalWidth-edge)/2,(image.naturalHeight-edge)/2,edge,edge,0,0,240,240);
    const result=canvas.toDataURL('image/jpeg',.78);
    if(!isGroupPhoto(result))throw Error('写真のサイズを小さくできませんでした。別の写真を選んでください。');
    return result;
  }finally{URL.revokeObjectURL(url);}
}
