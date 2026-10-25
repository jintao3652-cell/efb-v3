<?php
exec('ls',$data);
print_r($data);
foreach ($data as $temp){
    $send = $send."\"$temp\",";
}
echo $send;